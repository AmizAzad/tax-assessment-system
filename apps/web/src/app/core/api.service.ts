import { HttpClient, HttpParams } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { APP_CONFIG } from './config';

/**
 * Thin wrapper over HttpClient.
 *
 * Exists so that the base URL and the /api/v1 prefix live in one place rather
 * than being repeated in every feature service, and so a future change of
 * transport does not touch twenty files.
 */
@Injectable({ providedIn: 'root' })
export class ApiService {
  private readonly http = inject(HttpClient);
  private readonly base = `${APP_CONFIG.apiBaseUrl}/api/v1`;

  get<T>(path: string, params?: Record<string, string | number>): Promise<T> {
    let httpParams = new HttpParams();
    for (const [key, value] of Object.entries(params ?? {})) {
      httpParams = httpParams.set(key, String(value));
    }
    return firstValueFrom(this.http.get<T>(`${this.base}${path}`, { params: httpParams }));
  }

  post<T>(path: string, body?: unknown): Promise<T> {
    return firstValueFrom(this.http.post<T>(`${this.base}${path}`, body ?? {}));
  }

  /**
   * A file.
   *
   * Separate from `get` because a download is a different thing: the response
   * is bytes, the filename comes from `Content-Disposition`, and an error is
   * a JSON body inside a blob rather than a parsed object. Callers get both
   * parts so they can name the saved file what the server called it.
   */
  async getFile(path: string): Promise<{ blob: Blob; filename: string }> {
    const response = await firstValueFrom(
      this.http.get(`${this.base}${path}`, { observe: 'response', responseType: 'blob' }),
    );

    const disposition = response.headers.get('Content-Disposition') ?? '';
    const match = /filename="?([^"]+)"?/.exec(disposition);

    return {
      blob: response.body ?? new Blob(),
      // A fallback rather than an error: a missing header should not lose the
      // officer the file they waited for.
      filename: match?.[1] ?? path.split('/').pop() ?? 'download',
    };
  }
}
