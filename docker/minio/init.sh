#!/bin/sh
set -eu

: "${MINIO_ROOT_USER:?MINIO_ROOT_USER is required}"
: "${MINIO_ROOT_PASSWORD:?MINIO_ROOT_PASSWORD is required}"
: "${S3_BUCKET_RECORDINGS:?S3_BUCKET_RECORDINGS is required}"
: "${S3_BUCKET_KNOWLEDGE:?S3_BUCKET_KNOWLEDGE is required}"

alias_name=local
mc alias set \
  "$alias_name" \
  http://minio:9000 \
  "$MINIO_ROOT_USER" \
  "$MINIO_ROOT_PASSWORD" \
  --api S3v4 >/dev/null
mc ready "$alias_name"

for bucket in "$S3_BUCKET_RECORDINGS" "$S3_BUCKET_KNOWLEDGE"; do
  mc mb --ignore-existing "$alias_name/$bucket"
  mc stat "$alias_name/$bucket" >/dev/null
  echo "MinIO bucket is ready: $bucket"
done
