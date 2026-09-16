import {
  NoticeRenderError,
  hashContent,
  renderNotice,
  renderPdf,
  tokensIn,
} from '../src/tax-assessment/notice/notice-renderer';

/**
 * Rendering the legal instrument.
 *
 * Plan reference: V2 sections 12.2, 12.3.
 *
 * The failures these guard against are the ones that reach a member of the
 * public: a notice with a visible `{{placeholder}}`, a figure a template
 * computed for itself, or a hash that reports an untouched notice as altered.
 */
describe('notice rendering', () => {
  const values = {
    taxpayerName: 'Acme Trading Ltd',
    netPayable: '16742.00',
    currency: 'GBP',
    paymentDueDate: '2025-10-01',
  };

  describe('substitution', () => {
    it('replaces every token', () => {
      const rendered = renderNotice(
        'Notice for {{taxpayerName}}',
        'You must pay {{currency}} {{netPayable}} by {{paymentDueDate}}.',
        values,
      );

      expect(rendered.title).toBe('Notice for Acme Trading Ltd');
      expect(rendered.body).toBe('You must pay GBP 16742.00 by 2025-10-01.');
    });

    it('tolerates spacing inside the braces', () => {
      const rendered = renderNotice('{{ taxpayerName }}', 'x', values);
      expect(rendered.title).toBe('Acme Trading Ltd');
    });

    it('substitutes a token that appears more than once', () => {
      const rendered = renderNotice('x', '{{currency}} {{netPayable}} ({{currency}})', values);
      expect(rendered.body).toBe('GBP 16742.00 (GBP)');
    });

    it('refuses to render when a token has no value', () => {
      // A notice served with a visible placeholder is a defect delivered to a
      // member of the public. Better to fail before it is issued.
      expect(() => renderNotice('x', 'Pay {{amountOwing}} now', values)).toThrow(NoticeRenderError);
    });

    it('names every missing token, not just the first', () => {
      try {
        renderNotice('{{alpha}}', '{{beta}} {{gamma}}', values);
        fail('should have thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(NoticeRenderError);
        expect((error as NoticeRenderError).missingTokens).toEqual(['alpha', 'beta', 'gamma']);
      }
    });

    it('does not treat an empty string as a missing value', () => {
      // A legitimately blank value is different from an absent one.
      const rendered = renderNotice('x', 'Reference: {{ref}}.', { ...values, ref: '' });
      expect(rendered.body).toBe('Reference: .');
    });

    it('cannot compute anything', () => {
      // The template language is substitution and nothing else. A template
      // that could do arithmetic could contradict the approved calculation.
      expect(() => renderNotice('x', '{{netPayable + 1}}', values)).toThrow(NoticeRenderError);
    });

    it('leaves text that merely looks like a token alone', () => {
      const rendered = renderNotice('x', 'Braces { like this } are ordinary text.', values);
      expect(rendered.body).toBe('Braces { like this } are ordinary text.');
    });
  });

  describe('tokensIn', () => {
    it('lists the tokens a template uses, sorted and deduplicated', () => {
      expect(tokensIn('{{b}} {{a}} {{b}}')).toEqual(['a', 'b']);
    });

    it('returns nothing for a template with no tokens', () => {
      expect(tokensIn('Plain wording.')).toEqual([]);
    });
  });

  describe('the content hash', () => {
    it('is stable across renders of the same content', () => {
      const first = renderNotice('T {{currency}}', 'B {{netPayable}}', values);
      const second = renderNotice('T {{currency}}', 'B {{netPayable}}', values);
      expect(first.contentHash).toBe(second.contentHash);
    });

    it('does not depend on the order of the values', () => {
      const forward = hashContent('T', 'B', { a: '1', b: '2' });
      const backward = hashContent('T', 'B', { b: '2', a: '1' });
      expect(forward).toBe(backward);
    });

    it('changes when a figure changes', () => {
      // The whole point of verification: an altered amount must not verify.
      const original = hashContent('T', 'Pay 100.00', { netPayable: '100.00' });
      const altered = hashContent('T', 'Pay 100.00', { netPayable: '10.00' });
      expect(original).not.toBe(altered);
    });

    it('changes when the body changes', () => {
      expect(hashContent('T', 'A', {})).not.toBe(hashContent('T', 'B', {}));
    });
  });

  describe('PDF rendering', () => {
    it('produces a PDF', async () => {
      const rendered = renderNotice('Notice of Assessment', 'You owe {{netPayable}}.', values);
      const pdf = await renderPdf(rendered, 'TA-0001-ASSESSMENT-01');

      expect(pdf.subarray(0, 5).toString('latin1')).toBe('%PDF-');
      expect(pdf.length).toBeGreaterThan(500);
    });

    it('refuses a script the built-in fonts cannot draw', async () => {
      // Silently dropping unsupported glyphs would produce a legally defective
      // notice that looks fine to whoever pressed the button.
      const rendered = renderNotice('إشعار تقدير', 'نص', {});
      await expect(renderPdf(rendered, 'TA-0001-ASSESSMENT-01')).rejects.toThrow(
        /cannot draw|Embed a font/,
      );
    });

    it('accepts accented Latin text', async () => {
      const rendered = renderNotice('Avis d’imposition', 'Société Générale à Paris', {});
      const pdf = await renderPdf(rendered, 'TA-0001-ASSESSMENT-01');
      expect(pdf.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    });
  });
});
