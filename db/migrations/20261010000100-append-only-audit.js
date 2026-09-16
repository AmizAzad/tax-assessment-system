'use strict';

/**
 * Make the audit ledger append-only in the database.
 *
 * Plan reference: V2 section 19.3 (audit integrity), section 19.2 (the domain
 * event ledger is the system of record).
 *
 * ## Why this is not a GRANT
 *
 * The plan says "database-level revoke of UPDATE and DELETE for the
 * application role". That control only works when the application connects as
 * a role that does not own the tables. In this deployment — and in most
 * deployments before somebody separates the migration role from the runtime
 * role — the application *is* the owner, and an owner can re-grant itself
 * anything it has revoked. A REVOKE would therefore look like a control in the
 * migration and be no control at all in production.
 *
 * A trigger cannot be bypassed that way. It applies to the owner, to a
 * superuser session, and to anybody who reaches the database with psql. That
 * is the property an audit control needs: the person you are guarding against
 * is the one holding the credentials.
 *
 * The grants are revoked as well, for the deployments that do separate the
 * roles. Both, not either.
 *
 * ## What is allowed, and why it is not a loophole
 *
 * `tax_assessment_event` is absolutely immutable: no UPDATE, no DELETE.
 *
 * `tax_assessment_evidence` needs one exception. When evidence is retrieved
 * again, the previous snapshot is marked `is_current = false` — the row stays,
 * the flag moves. So the trigger permits an UPDATE that changes nothing but
 * `is_current`, and refuses one that touches the request, the response, the
 * hash, or who retrieved it. Rewriting captured evidence is exactly the act
 * this control exists to stop; superseding it is the normal operation of the
 * table.
 *
 * The comparison is done by nulling the flag on both records and comparing the
 * whole row. That way a column added to the table in a later migration is
 * protected automatically, rather than being protected only if somebody
 * remembers to add it to a list here.
 */
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query(`
      CREATE OR REPLACE FUNCTION tax.refuse_mutation() RETURNS trigger AS $$
      BEGIN
        RAISE EXCEPTION
          'Table %.% is append-only: % is refused (plan section 19.3)',
          TG_TABLE_SCHEMA, TG_TABLE_NAME, TG_OP
          USING ERRCODE = 'raise_exception',
                HINT = 'Correct a mistaken entry by appending a correcting one.';
      END;
      $$ LANGUAGE plpgsql
    `);

    await queryInterface.sequelize.query(`
      CREATE OR REPLACE FUNCTION tax.refuse_evidence_rewrite() RETURNS trigger AS $$
      DECLARE
        before_row tax.tax_assessment_evidence;
        after_row  tax.tax_assessment_evidence;
      BEGIN
        before_row := OLD;
        after_row  := NEW;

        -- Neutralise the one field that is allowed to move, then insist the
        -- rest of the row is untouched.
        before_row.is_current := NULL;
        after_row.is_current  := NULL;

        IF before_row IS DISTINCT FROM after_row THEN
          RAISE EXCEPTION
            'Evidence rows are append-only: only is_current may change (plan section 19.3)'
            USING ERRCODE = 'raise_exception',
                  HINT = 'Retrieve evidence again; the new snapshot supersedes the old one.';
        END IF;

        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql
    `);

    await queryInterface.sequelize.query(`
      CREATE TRIGGER trg_event_append_only
        BEFORE UPDATE OR DELETE ON tax.tax_assessment_event
        FOR EACH ROW EXECUTE FUNCTION tax.refuse_mutation()
    `);

    await queryInterface.sequelize.query(`
      CREATE TRIGGER trg_evidence_no_delete
        BEFORE DELETE ON tax.tax_assessment_evidence
        FOR EACH ROW EXECUTE FUNCTION tax.refuse_mutation()
    `);

    await queryInterface.sequelize.query(`
      CREATE TRIGGER trg_evidence_no_rewrite
        BEFORE UPDATE ON tax.tax_assessment_evidence
        FOR EACH ROW EXECUTE FUNCTION tax.refuse_evidence_rewrite()
    `);

    // For deployments that run the application under a role it does not own
    // the schema with. Harmless where it does.
    await queryInterface.sequelize.query(`
      REVOKE UPDATE, DELETE, TRUNCATE
          ON tax.tax_assessment_event, tax.tax_assessment_evidence
        FROM PUBLIC
    `);

    await queryInterface.sequelize.query(`
      COMMENT ON TABLE tax.tax_assessment_event IS
        'Append-only domain event ledger. UPDATE and DELETE refused by trigger (plan 19.3).'
    `);
    await queryInterface.sequelize.query(`
      COMMENT ON TABLE tax.tax_assessment_evidence IS
        'Append-only evidence snapshots. Only is_current may change (plan 19.3).'
    `);
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query(
      `DROP TRIGGER IF EXISTS trg_evidence_no_rewrite ON tax.tax_assessment_evidence`,
    );
    await queryInterface.sequelize.query(
      `DROP TRIGGER IF EXISTS trg_evidence_no_delete ON tax.tax_assessment_evidence`,
    );
    await queryInterface.sequelize.query(
      `DROP TRIGGER IF EXISTS trg_event_append_only ON tax.tax_assessment_event`,
    );
    await queryInterface.sequelize.query(`DROP FUNCTION IF EXISTS tax.refuse_evidence_rewrite()`);
    await queryInterface.sequelize.query(`DROP FUNCTION IF EXISTS tax.refuse_mutation()`);
  },
};
