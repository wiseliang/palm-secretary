import { z } from 'zod';

export const quizQuestionTypeSchema = z.enum([
  'single_choice', 'multiple_choice', 'true_false', 'unknown',
]);

export const quizAnalysisRequestSchema = z.object({
  schemaVersion: z.literal('1'),
  clientRequestId: z.string().uuid(),
  sourcePackage: z.string().min(1).max(255).regex(/^[A-Za-z0-9_.-]+$/),
  questionType: quizQuestionTypeSchema,
  question: z.string().trim().min(3).max(4_000),
  options: z.array(z.object({
    optionId: z.string().trim().min(1).max(16),
    text: z.string().trim().min(1).max(1_000),
  })).min(2).max(12).superRefine((options, context) => {
    const ids = new Set<string>();
    for (const option of options) {
      const id = option.optionId.toUpperCase();
      if (ids.has(id)) context.addIssue({ code: 'custom', message: '选项 ID 不得重复' });
      ids.add(id);
    }
  }),
  captureMode: z.enum(['accessibility', 'ocr']),
}).strict();

export const quizVisionMetadataSchema = z.object({
  schemaVersion: z.literal('1'),
  clientRequestId: z.string().uuid(),
  sourcePackage: z.string().min(1).max(255).regex(/^[A-Za-z0-9_.-]+$/),
  captureMode: z.enum(['vision', 'hybrid']),
  questionType: quizQuestionTypeSchema.optional().default('unknown'),
  question: z.string().trim().max(4_000).optional().default(''),
  options: z.array(z.object({
    optionId: z.string().trim().min(1).max(16),
    text: z.string().trim().min(1).max(1_000),
  }).strict()).max(12).optional().default([]),
  imageWidth: z.number().int().positive().max(10_000).optional(),
  imageHeight: z.number().int().positive().max(10_000).optional(),
}).strict().superRefine((value, context) => {
  if (value.captureMode === 'hybrid' && (value.question.length < 3 || value.options.length < 2)) {
    context.addIssue({ code: 'custom', message: '混合识别需要题干和选项' });
  }
  const ids = new Set<string>();
  for (const option of value.options) {
    const id = option.optionId.toUpperCase();
    if (ids.has(id)) context.addIssue({ code: 'custom', message: '选项 ID 不得重复' });
    ids.add(id);
  }
});

export const quizOptionVerdictSchema = z.enum([
  'correct', 'incorrect', 'partially_correct', 'unknown',
]);

export const quizAnalysisResultSchema = z.object({
  schemaVersion: z.literal('1'),
  questionType: quizQuestionTypeSchema,
  answer: z.array(z.string().trim().min(1).max(16)).min(1).max(12),
  confidence: z.number().min(0).max(1),
  shortExplanation: z.string().trim().min(1).max(2_000),
  fullExplanation: z.string().trim().min(1).max(12_000),
  optionAnalysis: z.array(z.object({
    optionId: z.string().trim().min(1).max(16),
    verdict: quizOptionVerdictSchema,
    explanation: z.string().trim().min(1).max(2_000),
  }).strict()).max(12),
  knowledgePoints: z.array(z.string().trim().min(1).max(300)).max(20),
  memoryTip: z.string().trim().max(1_000),
  warnings: z.array(z.string().trim().min(1).max(500)).max(10),
}).strict().superRefine((result, context) => {
  const optionIds = new Set(result.optionAnalysis.map((item) => item.optionId.toUpperCase()));
  for (const answer of result.answer) {
    if (result.questionType !== 'true_false' && !optionIds.has(answer.toUpperCase())) {
      context.addIssue({ code: 'custom', message: '答案必须对应选项 ID' });
    }
  }
});

export type QuizAnalysisRequest = z.infer<typeof quizAnalysisRequestSchema>;
export type QuizVisionMetadata = z.infer<typeof quizVisionMetadataSchema>;
export type QuizAnalysisInput = QuizAnalysisRequest | QuizVisionMetadata;
export type QuizAnalysisResult = z.infer<typeof quizAnalysisResultSchema>;

export const quizApiErrorSchema = z.object({
  error: z.string(),
  code: z.enum(['MODEL_ERROR', 'MODEL_OUTPUT_INVALID', 'SERVER_ERROR', 'RATE_LIMITED']),
});
