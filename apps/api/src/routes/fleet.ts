import express from 'express';
import type { RequestHandler, Router } from 'express';

type FleetServicePort = {
  getFleetView: () => Promise<object>;
};

type FleetRouteDeps = {
  readonly fleet: FleetServicePort;
};

export const createFleetRouter = (deps: FleetRouteDeps): Router => {
  const router = express.Router();
  const getFleetHandler: RequestHandler = async (_req, res) => {
    const view = await deps.fleet.getFleetView();
    res.status(200).json(view);
  };
  router.get('/', getFleetHandler);
  return router;
};

