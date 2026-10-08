/**
 * The documented message-body bound equals the one the server enforces.
 *
 * ## The drift this pins
 *
 * The spec said `maxLength: 8000` while `sendExchangeMessage` refused anything
 * over **4000** — exactly 2x. So a client trusting the document sent 6000
 * characters and was refused with `MESSAGE_TOO_LONG`, a code the document did
 * not list either. agrent-ios found the real bound on the wire and capped at
 * 4000 by observation (#1391).
 *
 * Restating a number in a second place is how it drifts. This asserts the
 * IDENTITY rather than the value, so a future change to the limit needs one
 * edit and the spec follows — and if somebody edits only one, this fails.
 *
 * ## What it deliberately does NOT assert
 *
 * That the request VALIDATOR equals 4000. It is 8000 on purpose: Zod cannot
 * sanitise, and the real check must happen after tags are stripped, so the
 * validator is a cheap outer bound rejecting absurd payloads while the usecase
 * is the gate. Tightening it to 4000 would make `MESSAGE_TOO_LONG` UNREACHABLE
 * — Zod would refuse first with a generic validation error — which would
 * remove the very code a client switches on. The relationship asserted below
 * is therefore validator >= documented, not validator == documented.
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { MAX_BODY_LENGTH } from '@/app-layer/usecases/exchange-messaging';
import { SendExchangeMessageSchema } from '@/app-layer/schemas/exchange-messaging.schemas';

const spec = JSON.parse(
    readFileSync(join(__dirname, '../../src/generated/openapi.json'), 'utf8'),
) as {
    components: { schemas: Record<string, { properties?: Record<string, { maxLength?: number; minLength?: number }> }> };
};

describe('the documented exchange body bound matches the enforced one', () => {
    const body = spec.components.schemas.SendExchangeMessage?.properties?.body;

    it('control: the spec actually describes this field', () => {
        // Without this, every assertion below passes vacuously on a renamed
        // schema or a moved property — an empty selection is a pass.
        expect(body).toBeDefined();
        expect(typeof body?.maxLength).toBe('number');
    });

    it('documented maxLength IS the usecase constant', () => {
        expect(body?.maxLength).toBe(MAX_BODY_LENGTH);
    });

    it('the validator is LOOSER than the documented bound, deliberately', () => {
        // Equal would mean Zod refuses before the usecase can, making
        // MESSAGE_TOO_LONG unreachable. Tighter would mean the spec promises
        // more than the server accepts. Only looser is correct.
        const max = SendExchangeMessageSchema.shape.body.maxLength;
        expect(max).not.toBeNull();
        expect(max as number).toBeGreaterThan(MAX_BODY_LENGTH);
    });

    it('both refusal codes are documented on the route', () => {
        const text = readFileSync(
            join(__dirname, '../../src/generated/openapi.json'),
            'utf8',
        );
        expect(text).toContain('MESSAGE_TOO_LONG');
        expect(text).toContain('MESSAGE_EMPTY');
    });
});
