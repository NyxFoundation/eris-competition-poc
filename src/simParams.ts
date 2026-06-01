import { Rng } from "./rng.js";

export type SimSampledParams = {
  sigmaPerStep: number;
  poissonLambda: number;
  lognormalMeanY: number;
  lognormalSigma: number;
};

export const SIGMA_PER_STEP_MIN = 0.00088;
export const SIGMA_PER_STEP_MAX = 0.00101;
export const POISSON_LAMBDA_MIN = 0.6;
export const POISSON_LAMBDA_MAX = 1.0;
export const LOGNORMAL_MEAN_Y_MIN = 19;
export const LOGNORMAL_MEAN_Y_MAX = 21;
export const LOGNORMAL_SIGMA = 1.2;

export function sampleSimParams(rng: Rng): SimSampledParams {
  return {
    sigmaPerStep: rng.uniform(SIGMA_PER_STEP_MIN, SIGMA_PER_STEP_MAX),
    poissonLambda: rng.uniform(POISSON_LAMBDA_MIN, POISSON_LAMBDA_MAX),
    lognormalMeanY: rng.uniform(LOGNORMAL_MEAN_Y_MIN, LOGNORMAL_MEAN_Y_MAX),
    lognormalSigma: LOGNORMAL_SIGMA
  };
}
