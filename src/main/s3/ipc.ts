import type { S3CreateFolderRequest, S3UploadFilesRequest } from '../../shared/s3-sync'
import { s3CreateFolderRequestSchema, s3UploadFilesRequestSchema } from '../../shared/s3-sync'
import { ipcMainHandle } from '../ipc-handler-registry'
import type { S3UploadService } from './upload-service'

// Manual-upload channel: the renderer picks project files + a destination folder inside the
// configured bucket; the serial upload queue does the rest.
const registerS3IpcHandlers = (service: S3UploadService): void => {
  ipcMainHandle('settings:upload-files-to-s3', (_event, request: S3UploadFilesRequest) => {
    const parsed = s3UploadFilesRequestSchema.parse(request)
    return service.uploadFilesManually({
      projectId: parsed.projectId,
      fileIds: parsed.fileIds,
      destinationPrefix: parsed.prefix
    })
  })

  ipcMainHandle('settings:create-s3-folder', (_event, request: S3CreateFolderRequest) => {
    const parsed = s3CreateFolderRequestSchema.parse(request)
    return service.createDestinationFolder(parsed.prefix)
  })
}

export { registerS3IpcHandlers }
