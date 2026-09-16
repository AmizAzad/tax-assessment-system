import { Logger } from '@nestjs/common';
import { FieldType } from '@tas/dynaforms-core';
import {
  EvidenceUnavailableError,
  type EvidenceRequest,
} from '../src/tax-assessment/evidence/evidence-provider';
import { FilingEvidenceProvider } from '../src/tax-assessment/evidence/filing.provider';

/**
 * Mapping a filed return to tax concepts.
 *
 * Plan reference: V2 sections 8.2, 8.4.
 *
 * This is the seam where a form becomes an assessment. Every test below is a
 * way the mapping can be wrong while still looking like it worked, which is the
 * dangerous kind: a doubled figure, a missing answer read as a declared nil, or
 * a float where an exact decimal was required.
 *
 * Sequelize is stubbed. The query is one `SELECT`; the mapping is the part that
 * needs holding still.
 */
describe('FilingEvidenceProvider', () => {
  const request: EvidenceRequest = {
    caseId: 1,
    taxpayerId: 1,
    tin: '1234567890',
    jurisdictionCode: 'GB',
    taxTypeCode: 'CIT',
    assessmentYear: '2024',
    currencyCode: 'GBP',
    correlationId: 'test-correlation',
  };

  function providerReturning(row: Record<string, unknown> | undefined) {
    const sequelize = { query: jest.fn().mockResolvedValue(row === undefined ? [] : [row]) };
    return new FilingEvidenceProvider(sequelize as never);
  }

  function submission(values: Record<string, unknown>, elements: unknown[]) {
    return {
      id: '10',
      json: values,
      definition: { schemaVersion: '1.0', root: elements },
      template_code: 'CIT-RETURN-GB',
      reference_number: 'CIT-2024-000001',
      submitted_at: new Date('2026-02-10T00:00:00Z'),
    };
  }

  it('maps only the fields that declare a tax concept', async () => {
    // Turnover carries no concept: it is context for a caseworker, not a
    // figure that should enter the assessment base.
    const provider = providerReturning(
      submission({ turnover: '2400000.00', tradingProfit: '180000.00' }, [
        {
          uuid: 'a',
          jsonKey: 'section',
          fieldType: FieldType.SECTION,
          children: [
            { uuid: 'b', jsonKey: 'turnover', fieldType: FieldType.NUMBER },
            {
              uuid: 'c',
              jsonKey: 'tradingProfit',
              fieldType: FieldType.NUMBER,
              taxConcept: 'TRADING_PROFIT',
            },
          ],
        },
      ]),
    );

    const payload = await provider.fetch(request);

    expect(payload.items.length).toBe(1);
    expect(payload.items[0]!.conceptCode).toBe('TRADING_PROFIT');
    expect(payload.items[0]!.declaredAmount.toString()).toBe('180000');
    expect(payload.items[0]!.source).toBe('FILED');
  });

  it('recurses into nested children', async () => {
    const provider = providerReturning(
      submission({ deep: '500.00' }, [
        {
          uuid: 'a',
          jsonKey: 'outer',
          fieldType: FieldType.SECTION,
          children: [
            {
              uuid: 'b',
              jsonKey: 'inner',
              fieldType: FieldType.CONTAINER,
              children: [
                {
                  uuid: 'c',
                  jsonKey: 'deep',
                  fieldType: FieldType.NUMBER,
                  taxConcept: 'PROPERTY_INCOME',
                },
              ],
            },
          ],
        },
      ]),
    );

    const payload = await provider.fetch(request);
    expect(payload.items.map((i) => i.conceptCode)).toEqual(['PROPERTY_INCOME']);
  });

  it('skips a concept whose value is absent rather than reading it as zero', async () => {
    // An unanswered question and a declared nil are different claims, and only
    // the second should reduce an assessment.
    const provider = providerReturning(
      submission({}, [
        {
          uuid: 'a',
          jsonKey: 'interestReceived',
          fieldType: FieldType.NUMBER,
          taxConcept: 'INTEREST_RECEIVED',
        },
      ]),
    );

    const payload = await provider.fetch(request);
    expect(payload.items.length).toBe(0);
  });

  it('keeps a declared nil, because that is an answer', async () => {
    const provider = providerReturning(
      submission({ interestReceived: '0.00' }, [
        {
          uuid: 'a',
          jsonKey: 'interestReceived',
          fieldType: FieldType.NUMBER,
          taxConcept: 'INTEREST_RECEIVED',
        },
      ]),
    );

    const payload = await provider.fetch(request);
    expect(payload.items.length).toBe(1);
    expect(payload.items[0]!.declaredAmount.isZero()).toBe(true);
  });

  it('refuses a template that declares the same concept twice', async () => {
    // Picking one would silently halve or double the figure depending on which.
    const provider = providerReturning(
      submission({ a: '100.00', b: '200.00' }, [
        { uuid: 'x', jsonKey: 'a', fieldType: FieldType.NUMBER, taxConcept: 'TRADING_PROFIT' },
        { uuid: 'y', jsonKey: 'b', fieldType: FieldType.NUMBER, taxConcept: 'TRADING_PROFIT' },
      ]),
    );

    await expect(provider.fetch(request)).rejects.toThrow(EvidenceUnavailableError);
    await expect(provider.fetch(request)).rejects.toThrow(/more than one field/);
  });

  it('rejects a value that is not an amount at all', async () => {
    const provider = providerReturning(
      submission({ profit: { nested: true } }, [
        { uuid: 'x', jsonKey: 'profit', fieldType: FieldType.NUMBER, taxConcept: 'TRADING_PROFIT' },
      ]),
    );

    await expect(provider.fetch(request)).rejects.toThrow(/not an amount/);
  });

  it('reads the filing date, which is what drives the late-filing penalty', async () => {
    const provider = providerReturning(
      submission({ profit: '1.00' }, [
        { uuid: 'x', jsonKey: 'profit', fieldType: FieldType.NUMBER, taxConcept: 'TRADING_PROFIT' },
      ]),
    );

    const payload = await provider.fetch(request);
    expect(payload.filedOn).toBe('2026-02-10');
  });

  describe('a taxpayer who did not file', () => {
    it('is not an error: no items, and no filing date', async () => {
      // A non-filer is a normal and common assessment case. Throwing here
      // would block exactly the cases an authority most wants to assess.
      const provider = providerReturning(undefined);

      const payload = await provider.fetch(request);

      expect(payload.items.length).toBe(0);
      expect(payload.filedOn).toBeUndefined();
      expect(payload.raw).toEqual({ filed: false });
    });
  });

  describe('a submission with no template definition', () => {
    it('fails rather than guessing what the figures mean', async () => {
      const provider = providerReturning({
        id: '10',
        json: { profit: '1.00' },
        definition: null,
        template_code: 'CIT-RETURN-GB',
        reference_number: 'CIT-2024-000001',
        submitted_at: new Date(),
      });

      await expect(provider.fetch(request)).rejects.toThrow(/no template definition/);
    });
  });

  describe('exactness', () => {
    it('preserves a decimal string exactly', async () => {
      const provider = providerReturning(
        submission({ profit: '12345.6789' }, [
          {
            uuid: 'x',
            jsonKey: 'profit',
            fieldType: FieldType.NUMBER,
            taxConcept: 'TRADING_PROFIT',
          },
        ]),
      );

      const payload = await provider.fetch(request);
      expect(payload.items[0]!.declaredAmount.toDatabaseValue()).toBe('12345.6789');
    });

    it('accepts a JSON number but warns, because exactness was lost upstream', async () => {
      const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
      const provider = providerReturning(
        submission({ profit: 180000.5 }, [
          {
            uuid: 'x',
            jsonKey: 'profit',
            fieldType: FieldType.NUMBER,
            taxConcept: 'TRADING_PROFIT',
          },
        ]),
      );

      const payload = await provider.fetch(request);

      expect(payload.items[0]!.declaredAmount.toString()).toBe('180000.5');
      // Blocking a real return over this would be worse than saying so loudly.
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('ADR-007'));
      warn.mockRestore();
    });
  });
});
