import { Router } from 'express';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { requireAuth, type JwtPayload } from './auth';
import { config } from '../config';
import pool from '../db';

export const recordingsRouter = Router();

const s3 = new S3Client({
  endpoint:   config.S3_ENDPOINT,
  region:     config.S3_REGION,
  credentials: {
    accessKeyId:     config.S3_ACCESS_KEY,
    secretAccessKey: config.S3_SECRET_KEY,
  },
  forcePathStyle: true,
});

// GET /api/v1/recordings/:id/audio — получить presigned URL для воспроизведения
recordingsRouter.get('/:id/audio', requireAuth, async (req, res): Promise<void> => {
  const user = (req as typeof req & { user: JwtPayload }).user;

  const result = await pool.query<{
    id: string; s3_key: string; duration_seconds: number; conversation_id: string;
  }>(
    `SELECT r.id, r.s3_key, r.duration_seconds, r.conversation_id
     FROM call_recordings r
     JOIN conversations c ON c.id = r.conversation_id
     WHERE r.id = $1 AND c.org_id = $2`,
    [req.params['id'], user.orgId]
  );

  if (result.rows.length === 0) {
    res.status(404).json({ error: 'Recording not found' });
    return;
  }

  const recording = result.rows[0]!;
  const signedUrl = await getSignedUrl(
    s3,
    new GetObjectCommand({
      Bucket: config.S3_BUCKET_RECORDINGS,
      Key:    recording.s3_key,
    }),
    { expiresIn: 3600 } // 1 час
  );

  res.json({
    url:      signedUrl,
    duration: recording.duration_seconds,
    expiresIn: 3600,
  });
});

// GET /api/v1/recordings/:id/transcript
recordingsRouter.get('/:id/transcript', requireAuth, async (req, res): Promise<void> => {
  const user = (req as typeof req & { user: JwtPayload }).user;

  const result = await pool.query(
    `SELECT r.transcript, r.highlights, r.quality_score
     FROM call_recordings r
     JOIN conversations c ON c.id = r.conversation_id
     WHERE r.id = $1 AND c.org_id = $2`,
    [req.params['id'], user.orgId]
  );

  if (result.rows.length === 0) {
    res.status(404).json({ error: 'Recording not found' });
    return;
  }

  res.json(result.rows[0]);
});

// GET /api/v1/recordings — список записей организации
recordingsRouter.get('/', requireAuth, async (req, res): Promise<void> => {
  const user   = (req as typeof req & { user: JwtPayload }).user;
  const limit  = parseInt(req.query['limit'] as string ?? '20');
  const offset = parseInt(req.query['offset'] as string ?? '0');

  const result = await pool.query(
    `SELECT
       r.id, r.duration_seconds, r.quality_score, r.created_at,
       c.id AS conversation_id, c.channel, c.started_at,
       l.phone, l.name AS lead_name
     FROM call_recordings r
     JOIN conversations c ON c.id = r.conversation_id
     LEFT JOIN leads l ON l.id = c.lead_id
     WHERE c.org_id = $1
     ORDER BY r.created_at DESC
     LIMIT $2 OFFSET $3`,
    [user.orgId, limit, offset]
  );

  res.json({ recordings: result.rows, limit, offset });
});
