/**
 * Guard: no column lands on a participant-readable DM table without a note
 * saying it is safe for the COUNTERPARTY to read (#2807).
 *
 * ## The same shape as `content-report-columns-are-reporter-safe`, one axis over
 *
 * P5.1 put `content_report_reporter_read` on `ContentReport` and then wrote a
 * guard, because **Postgres RLS is ROW-level, not column-level**: that arm
 * exposes every column of the reporter's own row, now and forever after.
 *
 * P8.1 (#2795) creates the same situation for direct messages.
 * `conversation_select` admits a row when the caller holds a
 * `ConversationParticipant` row for it — so every column of a `Conversation`,
 * a `DirectMessage` and a `MessageReaction` is readable by **every
 * participant**, which for a direct message means the other person.
 *
 * Today that is columns nobody would withhold. The risk is entirely in what
 * P8.3–P8.9 add: accept/decline metadata (a decliner may not want the other
 * party reading a timestamp of the decision), or anything a job writes about a
 * conversation. P5.5b's `NoticeScore` is the worked precedent for the second
 * case and the reason it is a separate TABLE: a score about a person must not
 * sit on a row that person can read.
 *
 * ## The population is DERIVED from the POLICIES, not from a list of names
 *
 * #2807 asked for this specifically, and it is why the file scans
 * `prisma/migrations/*‌/migration.sql` for `FOR SELECT` policies whose clause
 * references `"ConversationParticipant"`. A fifth DM table is in scope the
 * moment its policy is written, rather than when somebody remembers to add it
 * here — which is the difference between this and a hand-listed set.
 *
 * It also gets the EXCLUSION right for free, and that asymmetry is worth
 * knowing: `ConversationParticipant` itself is NOT in the population, because
 * its own policy is `"userId" = current_setting('app.user_id')` and references
 * no subquery. A new column there is visible to its own subject and nobody
 * else — so it needs no note, and a hand-written list would have had to
 * remember to leave it out.
 *
 * ## Why a note per column rather than a count
 *
 * A count would pass a column SWAP and would record nothing. The failure this
 * prevents is not somebody adding a column carelessly — it is somebody adding
 * one thoughtfully, for a good reason, without knowing about the arm.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { Prisma } from '@prisma/client';

import { collectSourceFiles } from '../helpers/collect-files';

const REPO_ROOT = path.join(__dirname, '..', '..');

/**
 * Models whose columns a conversation PARTICIPANT can read, derived from the
 * `FOR SELECT` policies that key on membership of `ConversationParticipant`.
 */
function participantReadableModels(): string[] {
    const migrations = collectSourceFiles({
        roots: ['prisma/migrations'],
        extensions: ['.sql'],
        // ~400 migration files; a floor well below it separates "no policy
        // references the participant table" from "nothing was examined".
        floor: 100,
    });
    const found = new Set<string>();
    for (const file of migrations) {
        const sql = readFileSync(file, 'utf8');
        const re = /CREATE POLICY\s+\w+\s+ON\s+"(\w+)"\s+FOR SELECT([\s\S]*?);\s*\n/g;
        let m: RegExpExecArray | null;
        while ((m = re.exec(sql)) !== null) {
            if (m[2].includes('"ConversationParticipant"')) found.add(m[1]);
        }
    }
    return [...found].sort();
}

/**
 * Every column, with why the OTHER PARTY may read it.
 *
 * Adding a column means adding an entry here. If you cannot write the reason,
 * that is the answer: it belongs on a table the counterparty cannot read.
 */
const COUNTERPARTY_SAFE: Readonly<Record<string, Readonly<Record<string, string>>>> = {
    Conversation: {
        id: 'The row id. An opaque cuid, and the counterparty already holds it — they are in the conversation.',
        createdAt: 'When the conversation was opened. Both parties were there.',
        updatedAt: 'Maintained by Prisma. It leaks no more than lastMessageAt does, below.',
        state:
            'REQUEST / ACCEPTED / DECLINED. Both parties need it: the opener has to know they are waiting, and the recipient has to know there is something to answer. A DECLINED state is visible to the person who was declined, which is deliberate — P8.2 answers them a not-found on every CONTENT path, so the state is how a client stops offering a composer rather than a disclosure of the decision.',
        initiatedByUserId:
            'Who opened it. Known to both — the opener wrote the first message, and P8.3 derives the counterparty from exactly that.',
        lastMessageAt:
            'When the last message landed. Both parties can see the message itself, so its timestamp adds nothing. It ALSO carries a security property — `direct_message_insert` reads it for the one-message request rule — but that is a property of the WRITE path, not a disclosure.',
    },
    DirectMessage: {
        attachmentKey:
            'An opaque storage key for the photo this message carries. The counterparty is the person the photo was SENT to — withholding the locator for an image they are meant to look at would be theatre. Possession of it grants nothing on its own: the egress route authorises by participation, so a third party holding the key still gets a not-found.',
        attachmentMime:
            'The image type. Needed to render it, and it says nothing the bytes do not.',
        attachmentBytes:
            'The size in bytes. The recipient is downloading the file, so they learn it exactly; a progress indicator is the honest use.',
        attachmentSha256:
            'The content digest. It lets a client dedupe a re-send and verify what it received. It is a hash OF the photo the counterparty already has, so it discloses nothing further — and it is not a lookup key against anything else, unlike `User.emailHash`.',
        id: 'The row id, for a message the counterparty can read.',
        conversationId: 'The conversation they are in.',
        senderUserId: 'Who wrote it. A message with no attributable sender is not a conversation.',
        body: 'The message. Encrypted at rest under the GLOBAL KEK precisely so BOTH parties can read it — see GLOBAL_KEK_MODELS.',
        createdAt:
            'When it was sent. The counterparty is reading the message itself, so the moment it arrived tells them nothing further — and a timeline needs it to order messages at all.',
        editedAt:
            'Whether it was edited, and when. Deliberately visible: a message silently rewritten after the other person read it is worse than one marked as edited.',
        deletedAt:
            'Whether it was deleted. The row keeps its place with a null body, so the counterparty sees that something was removed rather than the conversation renumbering under them.',
        idempotencyKey:
            'The SENDER\'s own replay key. Visible and harmless: it is an opaque client-generated string scoped to its sender, carries no content, and nothing can be done with another person\'s key — @@unique([senderUserId, idempotencyKey]) means it only ever matches rows that sender already owns.',
    },
    MessageReaction: {
        id: 'The row id, for a reaction the counterparty can see.',
        messageId: 'The message it sits on, which they can read.',
        userId: 'Who reacted. A reaction nobody can attribute is not a reaction.',
        emoji: 'The symbol. Capped short on purpose so it cannot carry prose — see the model docblock and push-payload-carries-no-free-text.',
        createdAt:
            'When they reacted. Visible for the same reason the reaction is: a reaction with no time cannot be ordered against the edits and replies around it.',
    },
};

describe('every participant-readable DM column is counterparty-safe (#2807)', () => {
    const models = participantReadableModels();

    it('reports the population it derived, so a zero would be visible', () => {
        // The denominator. Without it, every assertion below could range over
        // an empty model list and a broken SQL scan would read as a clean pass.
        console.log(
            `[dm-columns] ${models.length} participant-readable model(s) derived from policies: ` +
                models.join(', '),
        );
        expect(models.length).toBeGreaterThanOrEqual(3);
    });

    it('the derivation finds the three P8.1 tables and EXCLUDES the participant table', () => {
        // The control. A scan that matched everything, or nothing, would still
        // satisfy set equality against a map somebody had emptied.
        expect(models).toEqual(['Conversation', 'DirectMessage', 'MessageReaction']);
        // Not in scope, and that is the point: its own policy admits the
        // caller's OWN row only, so a column there is visible to its subject
        // and nobody else.
        expect(models).not.toContain('ConversationParticipant');
    });

    it('every derived model has a note map at all', () => {
        const unmapped = models.filter((m) => !COUNTERPARTY_SAFE[m]);
        if (unmapped.length > 0) {
            throw new Error(
                `${unmapped.length} model(s) gained a participant-readable SELECT policy with ` +
                    `no column notes in this file:\n  ${unmapped.join('\n  ')}\n\n` +
                    `A policy keyed on ConversationParticipant membership is ROW-level, so ` +
                    `every participant reads EVERY column of the matched row. Add a map here ` +
                    `with one sentence per column.`,
            );
        }
    });

    it('no column lacks a counterparty-safety note', () => {
        const problems: string[] = [];
        for (const name of models) {
            const model = Prisma.dmmf.datamodel.models.find((m) => m.name === name);
            expect(model).toBeDefined();
            const scalars = model!.fields.filter((f) => f.kind !== 'object').map((f) => f.name);
            const notes = COUNTERPARTY_SAFE[name] ?? {};
            for (const col of scalars.filter((c) => !notes[c])) {
                problems.push(`${name}.${col}`);
            }
        }
        if (problems.length > 0) {
            throw new Error(
                `${problems.length} column(s) have no counterparty-safety note:\n  ` +
                    problems.join('\n  ') +
                    `\n\nThese tables are read through a ROW-level policy keyed on conversation ` +
                    `membership, so the OTHER PARTY reads every column of the row — including ` +
                    `any you just added. Postgres RLS cannot restrict that to a subset.\n\n` +
                    `Add an entry to COUNTERPARTY_SAFE in this file saying why they may read ` +
                    `it. If you cannot write that sentence, the column belongs on a table the ` +
                    `counterparty cannot read — P5.5b's NoticeScore is the precedent, and the ` +
                    `reason it is a separate table rather than a column.`,
            );
        }
    });

    it('every note has a real reason, not a placeholder', () => {
        const thin: string[] = [];
        for (const [model, notes] of Object.entries(COUNTERPARTY_SAFE)) {
            for (const [col, reason] of Object.entries(notes)) {
                if (!reason || reason.trim().length < 25) thin.push(`${model}.${col}`);
            }
        }
        expect(thin).toEqual([]);
    });

    it('no note describes a column that no longer exists', () => {
        // The other direction. A note about a removed column is a statement
        // about nothing, and it misleads the next reader into thinking the
        // question was asked about the table as it stands.
        const stale: string[] = [];
        for (const [name, notes] of Object.entries(COUNTERPARTY_SAFE)) {
            const model = Prisma.dmmf.datamodel.models.find((m) => m.name === name);
            if (!model) {
                stale.push(`${name} (model is gone)`);
                continue;
            }
            const scalars = new Set(
                model.fields.filter((f) => f.kind !== 'object').map((f) => f.name),
            );
            for (const col of Object.keys(notes)) {
                if (!scalars.has(col)) stale.push(`${name}.${col}`);
            }
        }
        expect(stale).toEqual([]);
    });
});
