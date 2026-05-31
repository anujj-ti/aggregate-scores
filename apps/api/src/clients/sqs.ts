import { GetQueueUrlCommand, SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs';

import { mergeTaskSchema } from '@aggregate/shared';
import type { MergeTask } from '@aggregate/shared';

import type { ApiConfig } from '../config.js';

export interface SqsPort {
  sendMergeTask(task: MergeTask): Promise<void>;
}

type SqsDeps = {
  readonly config: ApiConfig;
};

export class SqsWorkQueue implements SqsPort {
  private readonly queueName: string;

  private readonly client: SQSClient;

  private queueUrl?: string;

  public constructor(deps: SqsDeps) {
    this.queueName = deps.config.queueWorkName;
    const config = {
      region: deps.config.awsRegion,
      credentials: {
        accessKeyId: deps.config.awsAccessKeyId,
        secretAccessKey: deps.config.awsSecretAccessKey,
        sessionToken: deps.config.awsSessionToken
      },
      ...(deps.config.awsEndpointUrl !== undefined ? { endpoint: deps.config.awsEndpointUrl } : {})
    };
    this.client = new SQSClient(config);
  }

  public async sendMergeTask(task: MergeTask): Promise<void> {
    const validTask = mergeTaskSchema.parse(task);
    const queueUrl = await this.getQueueUrl();
    await this.client.send(
      new SendMessageCommand({
        QueueUrl: queueUrl,
        MessageBody: JSON.stringify(validTask)
      })
    );
  }

  private async getQueueUrl(): Promise<string> {
    if (this.queueUrl !== undefined) {
      return this.queueUrl;
    }
    const result = await this.client.send(
      new GetQueueUrlCommand({
        QueueName: this.queueName
      })
    );
    if (result.QueueUrl === undefined) {
      throw new Error(`Queue URL not found for ${this.queueName}`);
    }
    this.queueUrl = result.QueueUrl;
    return this.queueUrl;
  }
}

