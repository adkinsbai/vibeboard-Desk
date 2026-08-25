#!/usr/bin/env bash
set -euo pipefail

backup_dir="/home/lincaigui/vibeboard/backups/postgres"
timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
temporary_file="$backup_dir/vibeboard-$timestamp.dump.gz.part"
final_file="$backup_dir/vibeboard-$timestamp.dump.gz"

mkdir -p "$backup_dir"
runuser -u postgres -- pg_dump --format=custom vibeboard | gzip -c > "$temporary_file"
mv "$temporary_file" "$final_file"
find "$backup_dir" -maxdepth 1 -type f -name 'vibeboard-*.dump.gz' -mtime +14 -delete
