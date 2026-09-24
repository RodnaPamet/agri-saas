/**
 * Request shapes for exchange messaging.
 *
 * Shape only. The rules that matter — how long a message may be after
 * sanitisation, who may open a thread, whether it is closed — live in
 * `usecases/exchange-messaging.ts`, because they are the same rules whichever
 * client calls. A schema that duplicated them would be a second place to
 * update; one that replaced them would leave the usecase trusting its caller.
 */
import { z } from 'zod';

export const SendExchangeMessageSchema = z
    .object({
        /** Bounded generously here; the usecase measures AFTER sanitising. */
        body: z.string().min(1).max(8000),
    })
    .strip();
export type SendExchangeMessageBody = z.infer<typeof SendExchangeMessageSchema>;
