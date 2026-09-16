import { BadRequestException, Controller, Get, Param } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Public } from '../../platform/auth/decorators';
import { NoticeService } from './notice.service';

/** A UUID and nothing else. Anything shorter is an enumeration attempt. */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Checking a notice without signing in.
 *
 * Plan reference: V2 section 20 ("public endpoints: only notice verification
 * and optionally objection filing … verification returns status only — never
 * financial detail"), section 19.3 (tamper evidence).
 *
 * ## Why this is public at all
 *
 * A demand for tax arrives by post. The person holding it has no account and
 * may have good reason to doubt it: a letter demanding money, quoting an
 * authority, is exactly the shape of a common fraud. Making them register in
 * order to check whether it is genuine defeats the purpose — the fraudulent
 * letter would carry its own convincing link.
 *
 * So verification is reachable by anybody who holds a notice reference, and
 * answers one question: does the authority's record say this notice exists,
 * and does its content still hash to what was issued.
 *
 * ## Why it returns almost nothing
 *
 * No amount, no taxpayer name, no case reference, no status of the
 * assessment. A notice reference is printed on a document that passes through
 * a postal system, an office and sometimes an agent, and anybody holding one
 * would otherwise learn what somebody else owes. The answer is deliberately
 * the narrowest true one.
 *
 * ## What stands in for a captcha
 *
 * The plan calls for one. A captcha needs a third-party service and a key,
 * neither of which belongs in this repository, so what is here instead is a
 * hard rate limit and a reference that cannot be guessed: a version-4 UUID,
 * rejected before any lookup if it is not well formed. Enumerating 2^122
 * references at thirty attempts a minute is not a strategy, and thirty leaves
 * room for an agent checking a batch of notices for one client. When a captcha
 * provider is chosen, it goes in front of this route and the limit stays.
 */
@ApiTags('public')
@Controller('public/notices')
export class PublicNoticeController {
  constructor(private readonly notices: NoticeService) {}

  @Get(':uuid/verify')
  @Public()
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @ApiOperation({
    summary: 'Confirm a notice is genuine and unaltered',
    description:
      'Open to anyone holding the reference printed on a notice. Returns whether the notice ' +
      'exists and whether its content still matches the hash recorded when it was issued. ' +
      'It returns no financial detail and no taxpayer identity.',
  })
  async verify(@Param('uuid') uuid: string): Promise<{
    known: boolean;
    noticeNumber: string | null;
    intact: boolean | null;
    checkedAt: string;
  }> {
    if (!UUID_PATTERN.test(uuid)) {
      throw new BadRequestException('That is not a notice reference');
    }

    const checkedAt = new Date().toISOString();

    try {
      const result = await this.notices.verify(uuid);
      return {
        known: true,
        // The notice number is on the document in the enquirer's hand, so
        // echoing it back tells them nothing they do not have, and lets them
        // confirm they typed the right reference.
        noticeNumber: result.noticeNumber,
        intact: result.intact,
        checkedAt,
      };
    } catch {
      // An unknown reference and a withdrawn one answer the same way. The
      // hashes are never returned either: they are an internal control, and
      // publishing them would let somebody test guesses against them offline.
      return { known: false, noticeNumber: null, intact: null, checkedAt };
    }
  }
}
