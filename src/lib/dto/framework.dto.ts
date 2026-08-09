/**
 * Framework & Requirement DTOs
 */
import { z } from '@/lib/openapi/zod';

export const FrameworkDTOSchema = z.object({
    id: z.string().optional(),
    key: z.string(),
    name: z.string(),
    version: z.string().nullable().optional(),
    description: z.string().nullable().optional(),
}).passthrough().openapi('Framework', {
    description: 'Compliance framework record (e.g. ISO 27001:2022, SOC 2, NIS2). Key is the stable lookup identifier.',
});

export type FrameworkDTO = z.infer<typeof FrameworkDTOSchema>;

export const RequirementDTOSchema = z.object({
    id: z.string(),
    code: z.string().nullable().optional(),
    title: z.string().nullable().optional(),
    description: z.string().nullable().optional(),
    section: z.string().nullable().optional(),
    category: z.string().nullable().optional(),
}).passthrough().openapi('Requirement', {
    description: 'A single requirement within a framework (e.g. ISO 27001:2022 A.5.1). Mapped to practices via PracticeRequirementMapRequest.',
});

export type RequirementDTO = z.infer<typeof RequirementDTOSchema>;
