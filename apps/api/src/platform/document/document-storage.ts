import {
  CreateBucketCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { createHash } from 'node:crypto';
import type { AppConfig } from '../../config/configuration';
import { APP_CONFIG } from '../../infrastructure/tokens';

export interface StoredObject {
  readonly storageKey: string;
  readonly sizeBytes: number;
  readonly checksumSha256: string;
}

/**
 * Object storage for evidence, notices and attachments.
 *
 * Plan reference: V2 sections 6.3, 20; ADR-010.
 *
 * S3-compatible, so MinIO locally and S3 or Azure Blob when deployed. The
 * interface is narrow on purpose: put, get, sign, delete. Anything richer
 * would couple the domain to a storage provider.
 *
 * ## Two controls live here rather than in the caller
 *
 * **Checksums.** Every object is hashed on write and the hash verified on
 * read. An evidence artefact that has changed since it was captured is worse
 * than one that is missing, because the assessment was defended on the
 * original.
 *
 * **Signed URLs.** A storage key is never returned to a client. Callers get a
 * short-lived signed URL, so access is time-boxed and cannot be shared
 * indefinitely or guessed from a predictable path.
 */
@Injectable()
export class DocumentStorage implements OnModuleInit {
  private readonly logger = new Logger(DocumentStorage.name);
  private readonly client: S3Client;
  private readonly bucket: string;

  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {
    this.bucket = config.storage.bucket;
    this.client = new S3Client({
      region: config.storage.region,
      endpoint: config.storage.endpoint,
      // MinIO serves buckets as a path, not a subdomain.
      forcePathStyle: true,
      credentials: {
        accessKeyId: config.storage.accessKey,
        secretAccessKey: config.storage.secretKey,
      },
    });
  }

  async onModuleInit(): Promise<void> {
    this.logger.log(`Document storage: ${this.config.storage.endpoint}/${this.bucket}`);

    // Reachability is not a boot requirement: an object store that is briefly
    // unavailable should not stop the API serving everything that does not
    // touch documents. So this is attempted and logged, never thrown.
    await this.ensureBucket();
  }

  /**
   * Create the bucket if it is not there.
   *
   * A fresh environment otherwise fails on its first upload with `NoSuchBucket`
   * raised from deep inside the AWS SDK, which reads as a code fault rather
   * than the one-line setup step it actually is. Creating it here means
   * `docker compose up` followed by a notice generation works, which is what
   * a developer reasonably expects.
   *
   * In a real deployment the bucket is provisioned with its own lifecycle,
   * versioning and retention policy, and the credentials this service holds
   * would not be allowed to create one. That is why a failure here is a
   * warning and not a crash: the deployment where this call is refused is also
   * the deployment where the bucket already exists.
   */
  private async ensureBucket(): Promise<void> {
    try {
      await this.client.send(new HeadBucketCommand({ Bucket: this.bucket }));
      return;
    } catch (error) {
      const status = (error as { $metadata?: { httpStatusCode?: number } }).$metadata
        ?.httpStatusCode;
      if (status !== 404 && status !== 403) {
        this.logger.warn(
          `Could not check bucket '${this.bucket}': ` +
            (error instanceof Error ? error.message : String(error)),
        );
        return;
      }
      if (status === 403) {
        // It exists and is someone else's to manage. Nothing to do.
        return;
      }
    }

    try {
      await this.client.send(new CreateBucketCommand({ Bucket: this.bucket }));
      this.logger.log(`Created object storage bucket '${this.bucket}'`);
    } catch (error) {
      this.logger.warn(
        `Bucket '${this.bucket}' does not exist and could not be created: ` +
          (error instanceof Error ? error.message : String(error)) +
          '. Document upload will fail until it is provisioned.',
      );
    }
  }

  /**
   * Store an object, returning its key and checksum.
   *
   * The key embeds a date path and a random component: date so that lifecycle
   * rules can act on age, random so that a key cannot be guessed from the
   * owning case.
   */
  async put(body: Buffer, contentType: string, prefix = 'documents'): Promise<StoredObject> {
    const checksum = createHash('sha256').update(body).digest('hex');
    const datePath = new Date().toISOString().slice(0, 10).replace(/-/g, '/');
    const storageKey = `${prefix}/${datePath}/${checksum.slice(0, 16)}-${randomSuffix()}`;

    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: storageKey,
        Body: body,
        ContentType: contentType,
        // Stored alongside the object so integrity can be checked even if the
        // database row were lost.
        Metadata: { 'sha256-checksum': checksum },
      }),
    );

    return { storageKey, sizeBytes: body.length, checksumSha256: checksum };
  }

  /**
   * Fetch an object and verify it against the expected checksum.
   *
   * @throws ChecksumMismatchError when the stored bytes no longer hash to what
   *         was recorded at upload.
   */
  async get(storageKey: string, expectedChecksum?: string): Promise<Buffer> {
    const response = await this.client.send(
      new GetObjectCommand({ Bucket: this.bucket, Key: storageKey }),
    );

    const chunks: Buffer[] = [];
    const stream = response.Body as AsyncIterable<Uint8Array>;
    for await (const chunk of stream) {
      chunks.push(Buffer.from(chunk));
    }
    const body = Buffer.concat(chunks);

    if (expectedChecksum !== undefined) {
      const actual = createHash('sha256').update(body).digest('hex');
      if (actual !== expectedChecksum) {
        this.logger.error(
          `Checksum mismatch for ${storageKey}: expected ${expectedChecksum}, got ${actual}`,
        );
        throw new ChecksumMismatchError(storageKey, expectedChecksum, actual);
      }
    }

    return body;
  }

  /**
   * A short-lived URL for a client to fetch an object directly.
   *
   * @param expirySeconds default 300. Long enough to download, short enough
   *        that a leaked URL stops working quickly.
   */
  async signedUrl(storageKey: string, expirySeconds = 300): Promise<string> {
    return getSignedUrl(
      this.client,
      new GetObjectCommand({ Bucket: this.bucket, Key: storageKey }),
      { expiresIn: expirySeconds },
    );
  }

  /**
   * Permanently remove an object.
   *
   * Callers must check retention and legal hold first: this does not, because
   * those are domain rules and this class is storage.
   */
  async delete(storageKey: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: storageKey }));
    this.logger.warn(`Deleted object ${storageKey}`);
  }
}

export class ChecksumMismatchError extends Error {
  constructor(
    readonly storageKey: string,
    readonly expected: string,
    readonly actual: string,
  ) {
    super(
      `Stored object ${storageKey} failed its integrity check. ` +
        `It has changed since it was captured and must not be relied on as evidence.`,
    );
    this.name = 'ChecksumMismatchError';
  }
}

function randomSuffix(): string {
  return createHash('sha256').update(`${Date.now()}:${Math.random()}`).digest('hex').slice(0, 12);
}
