'use strict';

/**
 * The demo company, Acme Trading Ltd, and the taxpayer login that acts for it.
 *
 * Plan reference: V2 section 26.3.
 *
 * ## Why this exists
 *
 * Everything else assumes it. The demo return, the account entries and the
 * brought-forward loss in `20261002020000-demo-cit-return` all select the
 * taxpayer by TIN `1234567890`, and the portal migration links `acme-finance`
 * to it the same way. Nothing created it. On a database that already had the
 * company from before, all of that worked; on a fresh stack every one of
 * those inserts selected nothing, silently, and the portal user acted for
 * nobody.
 *
 * ## Why the link is repeated here
 *
 * The portal migration writes the `taxpayer_user` row, but migrations run
 * before seeds, so on a fresh stack it found no company to link. The link is
 * written again once the company exists. Both are guarded by NOT EXISTS, so
 * whichever runs second does nothing.
 *
 * Numbered to run before the demo return, which needs the company.
 */
const TIN = '1234567890';

module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query(
      `INSERT INTO platform.taxpayer
              (tin, name, taxpayer_kind, jurisdiction_code, status, registration_date,
               preferred_language, created_at, updated_at, is_active)
       SELECT :tin, 'Acme Trading Ltd', 'COMPANY', 'GB', 'ACTIVE', '2015-04-01',
              'en', now(), now(), true
        WHERE NOT EXISTS (SELECT 1 FROM platform.taxpayer WHERE tin = :tin)`,
      { replacements: { tin: TIN } },
    );

    await queryInterface.sequelize.query(
      `INSERT INTO platform.taxpayer_user
              (taxpayer_id, user_id, relationship, valid_from, created_at, updated_at, is_active)
       SELECT t.id, u.id, 'OWNER', '2020-01-01', now(), now(), true
         FROM platform.taxpayer t
         JOIN platform.app_user u ON u.username = 'acme-finance'
        WHERE t.tin = :tin
          AND NOT EXISTS (
            SELECT 1 FROM platform.taxpayer_user x
             WHERE x.taxpayer_id = t.id AND x.user_id = u.id)`,
      { replacements: { tin: TIN } },
    );
  },

  // The company is left in place: cases, notices and the append-only ledger
  // reference it once anyone has worked it, and a down that failed on the
  // first foreign key would be worse than one that does not pretend.
  async down(queryInterface) {
    await queryInterface.sequelize.query(
      `DELETE FROM platform.taxpayer_user
        WHERE taxpayer_id IN (SELECT id FROM platform.taxpayer WHERE tin = :tin)
          AND user_id IN (SELECT id FROM platform.app_user WHERE username = 'acme-finance')`,
      { replacements: { tin: TIN } },
    );
  },
};
