'use strict';

/**
 * Let a user seeded ahead of their first sign-in actually sign in.
 *
 * Plan reference: V2 section 6.1; ADR-003.
 *
 * ## The defect
 *
 * The taxpayer-portal migration seeds `acme-finance` so its taxpayer link has
 * a user to point at. It had to give the row an `external_subject`, and the
 * real one is a UUID Keycloak mints at realm import, unknown when the
 * migration runs. So it wrote `portal-demo-subject`, which no token will ever
 * carry.
 *
 * On a fresh database the first sign-in misses on subject, and the directory
 * tries to provision a new row for `acme-finance`. That collides with the
 * seeded row on `username`, the insert throws, and every request from the
 * taxpayer — `/me` first — is a 500. It was hidden on any database where the
 * user had signed in before this migration existed, because the seed skips
 * a username that is already there.
 *
 * ## Why a marker and not a username match
 *
 * The directory could bind any row whose username matches the token. That
 * would hand a row already bound to one IdP subject — its taxpayer links, its
 * delegations — to whoever next holds the username at the IdP. A deleted and
 * recreated account is a different person until an administrator says
 * otherwise.
 *
 * So a seeded row says it is waiting, with `pending:<username>`, and the
 * directory binds only rows that say so, once. A row bound to a real subject
 * is never rebound.
 */
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query(`
      UPDATE platform.app_user
         SET external_subject = 'pending:' || username,
             updated_at       = now()
       WHERE external_subject = 'portal-demo-subject'
    `);
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query(`
      UPDATE platform.app_user
         SET external_subject = 'portal-demo-subject',
             updated_at       = now()
       WHERE external_subject = 'pending:acme-finance'
    `);
  },
};
