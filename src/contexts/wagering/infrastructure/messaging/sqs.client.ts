import { SQSClient } from '@aws-sdk/client-sqs';

export function createSqsClient(options: {
  endpoint?: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
}): SQSClient {
  return new SQSClient({
    region: options.region,
    endpoint: options.endpoint,
    credentials: {
      accessKeyId: options.accessKeyId,
      secretAccessKey: options.secretAccessKey,
    },
  });
}
