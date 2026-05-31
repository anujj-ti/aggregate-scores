import type { FleetView } from '@aggregate/shared';

import type { DynamoPort } from '../clients/dynamo.js';
import { HttpError } from '../middleware/error-handler.js';

type FleetDeps = {
  readonly dynamo: DynamoPort;
  readonly maxWorkers: number;
};

export class FleetService {
  private readonly dynamo: DynamoPort;

  private readonly maxWorkers: number;

  public constructor(deps: FleetDeps) {
    this.dynamo = deps.dynamo;
    this.maxWorkers = deps.maxWorkers;
  }

  public async getFleetView(): Promise<FleetView> {
    const fleet = await this.dynamo.getFleet();
    return {
      W: fleet.W,
      inFlight: fleet.inFlight,
      free: fleet.W - fleet.inFlight
    };
  }

  public async setWorkers(count: number): Promise<FleetView> {
    if (count < 0 || count > this.maxWorkers) {
      throw new HttpError(400, `count must be between 0 and ${this.maxWorkers}`);
    }
    const fleet = await this.dynamo.setFleetW(count);
    return {
      W: fleet.W,
      inFlight: fleet.inFlight,
      free: fleet.W - fleet.inFlight
    };
  }
}

