/**
 * Erasure sweep.
 *
 * A request sets `erasure_due_at` 30 days out. This carries it out when the
 * date passes, and it is the part most implementations skip: a delete button
 * that only sets a flag is not erasure.
 *
 * What goes:
 *   name, email, phone, date of birth, address, emergency contact,
 *   medical notes, password, every live session, every payment method,
 *   the IP addresses in the audit log and consent ledger.
 *
 * What stays, and why:
 *   invoices, invoice lines and payments, because UK tax law requires six
 *   years of financial records and Article 17(3)(b) permits retention for
 *   compliance with a legal obligation. They point at a tombstone member row
 *   with no personal data in it.
 *
 *   the consent ledger and audit log, with identifiers stripped, because they
 *   are the evidence that the erasure itself was requested and performed.
 */

import { query, transaction } from './db.js';

export async function runErasureSweep(now = new Date()) {
  const due = await query(
    `SELECT id FROM members
      WHERE erasure_due_at IS NOT NULL
        AND erasure_due_at <= $1
        AND erased_at IS NULL
        AND status <> 'erased'`,
    [now]
  );

  const done = [];
  for (const member of due) {
    await eraseMember(member.id);
    done.push(member.id);
  }
  if (done.length) console.log(`[erasure] anonymised ${done.length} member(s)`);
  return done;
}

/** Anonymise a single member. Safe to call twice. */
export async function eraseMember(memberId) {
  return transaction(async (tx) => {
    // A tombstone email keeps the unique index satisfied without being routable.
    const placeholder = `erased-${memberId}@invalid`;

    await tx.query(
      `UPDATE members SET
         email = $2,
         password_hash = 'erased',
         first_name = 'Erased',
         last_name = 'Member',
         phone = '',
         date_of_birth = NULL,
         address_line1 = '', address_line2 = '', city = '', postcode = '',
         emergency_contact_name = '', emergency_contact_phone = '',
         medical_notes = '',
         status = 'erased',
         erased_at = now(),
         updated_at = now()
       WHERE id = $1`,
      [memberId, placeholder]
    );

    await tx.query(`UPDATE sessions SET revoked_at = now() WHERE member_id = $1 AND revoked_at IS NULL`, [memberId]);
    await tx.query('DELETE FROM payment_methods WHERE member_id = $1', [memberId]);

    await tx.query(
      `UPDATE subscriptions SET status = 'cancelled', cancelled_at = now(), updated_at = now()
        WHERE member_id = $1 AND status <> 'cancelled'`,
      [memberId]
    );

    // Bookings are attendance history, not financial record: drop the link to
    // the person but keep the class capacity figures honest.
    await tx.query(`UPDATE bookings SET status = 'cancelled', cancelled_at = now()
                     WHERE member_id = $1 AND status = 'booked'`, [memberId]);

    // Strip identifiers from the evidence trails without destroying them.
    await tx.query('UPDATE audit_log SET ip = NULL, user_agent = \'\' WHERE member_id = $1', [memberId]);
    await tx.query('UPDATE consents SET ip = NULL WHERE member_id = $1', [memberId]);
    await tx.query('UPDATE sessions SET ip = NULL, user_agent = \'\' WHERE member_id = $1', [memberId]);

    await tx.query(
      `UPDATE data_requests SET status = 'completed', completed_at = now()
        WHERE member_id = $1 AND type = 'erasure' AND status IN ('pending','in_progress')`,
      [memberId]
    );

    await tx.query(
      // member_id is uuid and entity_id is text. One placeholder cannot be both,
      // and a cast on the placeholder does not help, so bind it twice.
      `INSERT INTO audit_log (member_id, actor, action, entity, entity_id, metadata)
       VALUES ($1, 'system', 'data.erased', 'member', $2,
               '{"retained":"invoices, payments and invoice lines, for six year financial record keeping"}'::jsonb)`,
      [memberId, String(memberId)]
    );

    return memberId;
  });
}
