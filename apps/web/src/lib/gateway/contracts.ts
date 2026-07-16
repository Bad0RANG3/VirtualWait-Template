import { z } from "zod";

/**
 * Runtime view of the versioned Gateway v1 response contract. The canonical
 * JSON Schema is kept in packages/contracts; these schemas protect the Web
 * boundary before any response reaches application storage.
 */
export const gatewayCreateJobResponseSchema = z.object({
  jobId: z.string().trim().min(1).max(128),
});

export const gatewayVerificationResponseSchema = z.object({
  status: z.enum(["SUCCEEDED", "FAILED", "PROCESSING", "LOGGING_OUT"]),
  errorCode: z.string().trim().min(1).max(64).optional(),
  identityProof: z
    .object({ subject: z.string().regex(/^[a-f0-9]{64}$/) })
    .optional(),
  profile: z
    .object({
      displayName: z.string().trim().min(1).max(80),
      rating: z.number().int().min(0).max(30_000).optional(),
      title: z.string().trim().max(200).optional(),
  })
    .optional(),
}).superRefine((value, ctx) => {
  if (value.status === "SUCCEEDED" && (!value.identityProof || !value.profile)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "successful Gateway responses require identityProof and profile",
    });
  }
  if (value.status === "FAILED" && !value.errorCode) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "failed Gateway responses require errorCode",
    });
  }
});
