// Existing projects keep auto-upload off until the user enables it in the project form.
const projectS3AutoUploadMigration = {
  id: '0061_project_s3_auto_upload',
  statements: [
    `ALTER TABLE "Project" ADD COLUMN "s3AutoUpload" BOOLEAN NOT NULL DEFAULT false`
  ] as const,
  verifiers: [
    { kind: 'column-exists', version: 1, table: 'Project', column: 's3AutoUpload' }
  ] as const
}

export { projectS3AutoUploadMigration }
