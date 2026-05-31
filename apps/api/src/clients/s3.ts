import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

import type { ApiConfig } from '../config.js';

export interface S3Port {
  putObject(key: string, body: Uint8Array): Promise<void>;
  getSignedDownloadUrl(key: string, expiresSeconds?: number): Promise<string>;
  getObjectBytes(key: string): Promise<Uint8Array>;
}

type S3Deps = {
  readonly config: ApiConfig;
};

export class S3Store implements S3Port {
  private readonly bucketName: string;

  private readonly client: S3Client;

  public constructor(deps: S3Deps) {
    this.bucketName = deps.config.s3BucketName;
    const config = {
      region: deps.config.awsRegion,
      forcePathStyle: deps.config.awsEndpointUrl !== undefined,
      credentials: {
        accessKeyId: deps.config.awsAccessKeyId,
        secretAccessKey: deps.config.awsSecretAccessKey,
        sessionToken: deps.config.awsSessionToken
      },
      ...(deps.config.awsEndpointUrl !== undefined ? { endpoint: deps.config.awsEndpointUrl } : {})
    };
    this.client = new S3Client(config);
  }

  public async putObject(key: string, body: Uint8Array): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucketName,
        Key: key,
        Body: body
      })
    );
  }

  public async getSignedDownloadUrl(key: string, expiresSeconds: number = 3600): Promise<string> {
    const command = new GetObjectCommand({
      Bucket: this.bucketName,
      Key: key
    });
    return getSignedUrl(this.client, command, { expiresIn: expiresSeconds });
  }

  public async getObjectBytes(key: string): Promise<Uint8Array> {
    const response = await this.client.send(
      new GetObjectCommand({
        Bucket: this.bucketName,
        Key: key
      })
    );
    if (response.Body === undefined) {
      throw new Error(`S3 object ${key} has no body`);
    }
    return response.Body.transformToByteArray();
  }
}

