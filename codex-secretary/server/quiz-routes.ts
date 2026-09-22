import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { quizAnalysisRequestSchema, quizVisionMetadataSchema, type QuizAnalysisRequest,
  type QuizVisionMetadata } from './quiz-schema.js';
import type { QuizAnalysisOutcome } from './quiz-analyzer.js';

type Authorize = (request: FastifyRequest, reply: FastifyReply) => boolean;
type RateEntry = { count: number; resetAt: number };
type QuizAnalyzerLike = {
  analyze(request: QuizAnalysisRequest): Promise<QuizAnalysisOutcome>;
  analyzeVision(request: QuizVisionMetadata, imagePath: string): Promise<QuizAnalysisOutcome>;
};

export function registerQuizRoutes(app: FastifyInstance, authorize: Authorize,
    analyzer: QuizAnalyzerLike): void {
  const rates = new Map<string, RateEntry>();
  let active = 0;
  const maxConcurrent = 2;
  const consumeRate = (request: FastifyRequest) => {
    const session = createHash('sha256').update(request.cookies.palm_session ?? 'authenticated').digest('hex');
    const now = Date.now();
    const current = rates.get(session);
    const rate = current && current.resetAt > now ? current : { count: 0, resetAt: now + 60_000 };
    if (rate.count >= 6) return false;
    rate.count += 1;
    rates.set(session, rate);
    return true;
  };

  app.post('/api/quiz-analysis', { bodyLimit: 64 * 1024 }, async (request, reply) => {
    const routeStartedAt = Date.now();
    const authStarted = Date.now();
    if (!authorize(request, reply)) return;
    const authMs = Date.now() - authStarted;
    const schemaStarted = Date.now();
    const parsed = quizAnalysisRequestSchema.safeParse(request.body);
    const schemaValidationMs = Date.now() - schemaStarted;
    if (!parsed.success) return reply.code(400).send({ code: 'INVALID_REQUEST', error: '题目数据不完整或格式无效' });

    if (!consumeRate(request)) return reply.code(429).send({ code: 'RATE_LIMITED', error: '解析请求过于频繁，请稍后再试' });
    if (active >= maxConcurrent) return reply.code(503).send({ code: 'SERVER_ERROR', error: '解析服务繁忙，请稍后再试' });

    const input: QuizAnalysisRequest = parsed.data;
    active += 1;
    try {
      const outcome = await analyzer.analyze(input);
      const totalMs = Date.now() - routeStartedAt;
      const metrics = outcome.metrics;
      app.log.info({
        requestId: input.clientRequestId,
        questionType: input.questionType,
        optionCount: input.options.length,
        sourcePackage: input.sourcePackage,
        captureMode: input.captureMode,
        authMs,
        schemaValidationMs,
        ...metrics,
        totalMs,
        statusCode: 200,
      }, 'quiz request completed');
      void reply.header('Server-Timing', [
        `auth;dur=${authMs}`, `schema;dur=${schemaValidationMs}`,
        `bridge;dur=${metrics.bridgeAcquireMs}`, `thread;dur=${metrics.threadCreateMs}`,
        `model;dur=${metrics.modelTurnMs}`, `parse;dur=${metrics.outputParseMs}`,
        `repair;dur=${metrics.repairMs}`, `total;dur=${totalMs}`,
      ].join(', '));
      void reply.header('X-Palm-Quiz-Repair', metrics.repair ? '1' : '0');
      return outcome.result;
    } catch (error) {
      const reportedCode = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
      const code = reportedCode === 'MODEL_ERROR' || reportedCode === 'MODEL_OUTPUT_INVALID'
        ? reportedCode : 'SERVER_ERROR';
      const statusCode = code === 'SERVER_ERROR' ? 503 : 502;
      const metrics = error && typeof error === 'object' && 'metrics' in error
        ? error.metrics as Record<string, unknown> | undefined : undefined;
      app.log.warn({
        requestId: input.clientRequestId,
        questionType: input.questionType,
        optionCount: input.options.length,
        sourcePackage: input.sourcePackage,
        captureMode: input.captureMode,
        code,
        schemaValidationMs,
        ...metrics,
        totalMs: Date.now() - routeStartedAt,
        statusCode,
      }, 'quiz request failed');
      return reply.code(statusCode).send({ code, error: error instanceof Error ? error.message : '解析服务异常' });
    } finally {
      active -= 1;
    }
  });

  app.post('/api/quiz-analysis/vision', { bodyLimit: 4 * 1024 * 1024 }, async (request, reply) => {
    const routeStartedAt = Date.now();
    if (!authorize(request, reply)) return;
    if (!request.isMultipart()) return reply.code(400).send({ code:'INVALID_REQUEST', error:'必须使用 multipart/form-data' });
    if (!consumeRate(request)) return reply.code(429).send({ code:'RATE_LIMITED', error:'解析请求过于频繁，请稍后再试' });
    if (active >= maxConcurrent) return reply.code(503).send({ code:'SERVER_ERROR', error:'解析服务繁忙，请稍后再试' });
    const multipartStartedAt = Date.now();
    let metadataText = '';
    let metadataObject: unknown;
    let hasMetadata = false;
    let image: Buffer | undefined;
    let mimeType = '';
    try {
      for await (const part of request.parts({limits:{fileSize:3 * 1024 * 1024,files:1,fields:1,parts:2}})) {
        if (part.type === 'file') {
          if (part.fieldname !== 'image' || image) return reply.code(400).send({code:'INVALID_REQUEST',error:'只允许一个 image 文件'});
          mimeType = part.mimetype;
          image = await part.toBuffer();
          if (part.file.truncated || image.length > 3 * 1024 * 1024) return reply.code(413).send({code:'INVALID_REQUEST',error:'题目画面过大'});
        } else {
          if (part.fieldname !== 'metadata' || hasMetadata) return reply.code(400).send({code:'INVALID_REQUEST',error:'metadata 无效'});
          hasMetadata = true;
          if (typeof part.value === 'string') metadataText = part.value;
          else metadataObject = part.value;
          const metadataBytes = Buffer.byteLength(typeof part.value === 'string'
            ? part.value : JSON.stringify(part.value));
          if (metadataBytes > 64 * 1024) return reply.code(413).send({code:'INVALID_REQUEST',error:'metadata 过大'});
        }
      }
    } catch {
      return reply.code(413).send({code:'INVALID_REQUEST',error:'图片请求过大或格式无效'});
    }
    if (!image || !['image/jpeg','image/png'].includes(mimeType)) return reply.code(400).send({code:'INVALID_REQUEST',error:'只支持 JPEG 或 PNG'});
    const validMagic = mimeType === 'image/png'
      ? image.length >= 8 && image.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))
      : image.length >= 3 && image[0] === 0xff && image[1] === 0xd8 && image[2] === 0xff;
    if (!validMagic) return reply.code(400).send({code:'INVALID_REQUEST',error:'图片内容与格式不匹配'});
    let metadataValue: unknown;
    try { metadataValue = metadataObject ?? JSON.parse(metadataText); }
    catch { return reply.code(400).send({code:'INVALID_REQUEST',error:'metadata 不是有效 JSON'}); }
    const parsed = quizVisionMetadataSchema.safeParse(metadataValue);
    if (!parsed.success) return reply.code(400).send({code:'INVALID_REQUEST',error:'图片题数据不完整或格式无效'});
    const input = parsed.data;
    const multipartParseMs = Date.now() - multipartStartedAt;
    let temporaryDirectory = '';
    active += 1;
    try {
      const temporaryStartedAt = Date.now();
      temporaryDirectory = await mkdtemp(path.join(os.tmpdir(),'palm-quiz-vision-'));
      const imagePath = path.join(temporaryDirectory, mimeType === 'image/png' ? 'image.png' : 'image.jpg');
      await writeFile(imagePath,image,{mode:0o600});
      image.fill(0);
      const tempImageMs = Date.now() - temporaryStartedAt;
      const outcome = await analyzer.analyzeVision(input,imagePath);
      const metrics = outcome.metrics;
      const totalMs = Date.now() - routeStartedAt;
      await rm(temporaryDirectory,{recursive:true,force:true});
      temporaryDirectory='';
      app.log.info({requestId:input.clientRequestId,captureMode:input.captureMode,
        questionType:input.questionType,optionCount:input.options.length,imageBytes:image.length,
        imageWidth:input.imageWidth,imageHeight:input.imageHeight,multipartParseMs,tempImageMs,
        ...metrics,totalMs,statusCode:200},'quiz vision request completed');
      void reply.header('Server-Timing',[`multipart;dur=${multipartParseMs}`,`temp;dur=${tempImageMs}`,
        `thread;dur=${metrics.threadCreateMs}`,`model;dur=${metrics.modelTurnMs}`,`total;dur=${totalMs}`].join(', '));
      return outcome.result;
    } catch (error) {
      const reportedCode = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
      const code = reportedCode === 'MODEL_ERROR' || reportedCode === 'MODEL_OUTPUT_INVALID' ? reportedCode : 'SERVER_ERROR';
      const validationIssue = error && typeof error === 'object' && 'metrics' in error
        && error.metrics && typeof error.metrics === 'object' && 'validationIssue' in error.metrics
        ? String(error.metrics.validationIssue) : undefined;
      if (temporaryDirectory) {
        await rm(temporaryDirectory,{recursive:true,force:true});
        temporaryDirectory='';
      }
      app.log.warn({requestId:input.clientRequestId,captureMode:input.captureMode,imageBytes:image.length,
        code,validationIssue,totalMs:Date.now()-routeStartedAt,statusCode:code==='SERVER_ERROR'?503:502},'quiz vision request failed');
      return reply.code(code === 'SERVER_ERROR' ? 503 : 502).send({code,error:error instanceof Error?error.message:'解析服务异常'});
    } finally {
      image.fill(0);
      if (temporaryDirectory) await rm(temporaryDirectory,{recursive:true,force:true});
      active -= 1;
    }
  });
}
