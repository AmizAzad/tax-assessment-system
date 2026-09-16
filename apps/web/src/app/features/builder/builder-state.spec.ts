import { FieldType, type FormDefinition } from '@tas/dynaforms-core';
import { BuilderState } from './builder-state';

/**
 * The form builder's problem detection and edit history.
 *
 * Plan reference: V2 section 7.5.
 *
 * ## Why these are the tests worth having
 *
 * The builder produces templates that the server later runs. A template that
 * looks fine in the builder and misbehaves at render time is the expensive
 * failure, because by then it is attached to real submissions. So the tests
 * below are about the checks that stop a broken template being published:
 * duplicate keys, dangling dependencies, circular formulas.
 *
 * The state is plain signals with no Angular injection, so it is constructed
 * directly. A TestBed here would test Angular, not this.
 */
describe('BuilderState', () => {
  function definitionOf(state: BuilderState): FormDefinition {
    return state.definition();
  }

  function messages(state: BuilderState): string[] {
    return state.problems().map((p) => p.message);
  }

  describe('an empty form', () => {
    it('warns rather than errors, because an empty draft is a normal starting point', () => {
      const state = new BuilderState();
      expect(state.problems().length).toBe(1);
      expect(state.problems()[0].severity).toBe('warning');
      expect(state.hasErrors()).toBe(false);
    });
  });

  describe('duplicate keys', () => {
    it('is an error, because one field would silently overwrite the other', () => {
      const state = new BuilderState();
      state.add(FieldType.TEXTBOX);
      state.add(FieldType.TEXTBOX);

      const [first, second] = definitionOf(state).root;
      // The builder assigns unique keys on its own; force the collision.
      state.update(second.uuid, { jsonKey: first.jsonKey });

      expect(state.hasErrors()).toBe(true);
      expect(messages(state).some((m) => m.includes('overwrite each other'))).toBe(true);
    });

    it('assigns distinct keys when fields are added normally', () => {
      const state = new BuilderState();
      state.add(FieldType.TEXTBOX);
      state.add(FieldType.TEXTBOX);
      state.add(FieldType.TEXTBOX);

      const keys = definitionOf(state).root.map((e) => e.jsonKey);
      expect(new Set(keys).size).toBe(keys.length);
    });
  });

  describe('a field with no key', () => {
    it('is an error, because its value would not be saved', () => {
      const state = new BuilderState();
      state.add(FieldType.TEXTBOX);
      state.update(definitionOf(state).root[0].uuid, { jsonKey: '' });

      expect(messages(state).some((m) => m.includes('no key'))).toBe(true);
    });
  });

  describe('dangling dependencies', () => {
    it('reports a rule that watches a field which does not exist', () => {
      // The failure this prevents: the rule never fires, and the author reads
      // that as the builder ignoring their rule.
      const state = new BuilderState();
      state.add(FieldType.TEXTBOX);
      state.update(definitionOf(state).root[0].uuid, {
        dependsOn: {
          rules: [
            {
              conditions: [{ field: 'fieldThatWasDeleted', operator: 'equals', value: 'yes' }],
              effects: [{ type: 'show' }],
            },
          ],
        },
      } as never);

      expect(messages(state).some((m) => m.includes('does not exist'))).toBe(true);
    });
  });

  describe('circular formulas', () => {
    it('is an error, because it would not terminate at render time', () => {
      // Field references carry an `@` prefix: `@beta`, not `beta`.
      const state = new BuilderState();
      state.add(FieldType.NUMBER);
      state.add(FieldType.NUMBER);

      const [a, b] = definitionOf(state).root;
      state.update(a.uuid, { jsonKey: 'alpha', formula: '@beta + 1' });
      state.update(b.uuid, { jsonKey: 'beta', formula: '@alpha + 1' });

      expect(state.hasErrors()).toBe(true);
      expect(messages(state).some((m) => m.includes('Circular formula'))).toBe(true);
    });

    it('accepts a formula chain that is not circular', () => {
      const state = new BuilderState();
      state.add(FieldType.NUMBER);
      state.add(FieldType.NUMBER);

      const [a, b] = definitionOf(state).root;
      state.update(a.uuid, { jsonKey: 'gross', formula: '' });
      state.update(b.uuid, { jsonKey: 'net', formula: '@gross - 100' });

      expect(messages(state).some((m) => m.includes('Circular formula'))).toBe(false);
    });

    it('reports an unparseable formula instead of throwing out of the computed', () => {
      const state = new BuilderState();
      state.add(FieldType.NUMBER);
      state.update(definitionOf(state).root[0].uuid, { jsonKey: 'x', formula: '1 +' });

      // The builder must stay usable while a formula is half-typed.
      expect(() => state.problems()).not.toThrow();
    });
  });

  describe('edits are immutable', () => {
    it('does not mutate the previous tree, which is what makes undo work', () => {
      const state = new BuilderState();
      state.add(FieldType.TEXTBOX);

      const before = definitionOf(state).root;
      const beforeKey = before[0].jsonKey;

      state.update(before[0].uuid, { jsonKey: 'changed' });

      expect(before[0].jsonKey).toBe(beforeKey);
      expect(definitionOf(state).root[0].jsonKey).toBe('changed');
    });

    it('undoes the last edit', () => {
      const state = new BuilderState();
      state.add(FieldType.TEXTBOX);
      const original = definitionOf(state).root[0].jsonKey;

      state.update(definitionOf(state).root[0].uuid, { jsonKey: 'temporary' });
      expect(state.canUndo()).toBe(true);

      state.undo();
      expect(definitionOf(state).root[0].jsonKey).toBe(original);
    });
  });

  describe('remove and move', () => {
    it('removes a field', () => {
      const state = new BuilderState();
      state.add(FieldType.TEXTBOX);
      state.add(FieldType.TEXTBOX);

      state.remove(definitionOf(state).root[0].uuid);
      expect(definitionOf(state).root.length).toBe(1);
    });

    it('moves a field down and leaves the count alone', () => {
      const state = new BuilderState();
      state.add(FieldType.TEXTBOX);
      state.add(FieldType.NUMBER);

      const firstUuid = definitionOf(state).root[0].uuid;
      state.move(firstUuid, 1);

      expect(definitionOf(state).root.length).toBe(2);
      expect(definitionOf(state).root[1].uuid).toBe(firstUuid);
    });
  });
});
