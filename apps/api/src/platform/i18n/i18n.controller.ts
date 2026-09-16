import { Controller, Get, Param } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Public } from '../auth/decorators';
import { I18nService, type Language } from './i18n.service';

/**
 * Display key bundles for the SPA.
 *
 * @Public because labels are needed to render the login screen itself, and a
 * display key is not confidential: it is the text on a button.
 */
@ApiTags('i18n')
@Controller('i18n')
export class I18nController {
  constructor(private readonly i18n: I18nService) {}

  @Get('languages')
  @Public()
  @ApiOperation({ summary: 'Available languages and their text direction' })
  async languages(): Promise<readonly Language[]> {
    return this.i18n.listLanguages();
  }

  @Get('bundle/:languageCode')
  @Public()
  @ApiOperation({ summary: 'Every display key for a language' })
  async bundle(
    @Param('languageCode') languageCode: string,
  ): Promise<Readonly<Record<string, string>>> {
    return this.i18n.bundle(languageCode);
  }
}
