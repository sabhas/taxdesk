/**
 * Public surface of the TD-005 OneDrive feasibility spike harness.
 *
 * The product never imports this package: it exists so the spike can be
 * executed repeatably and so its report can be validated in tests. Production
 * document storage will use the separate `DocumentStorageProvider` port in
 * Epic 4, not this module.
 */
export { evaluateSpikeResults, type SpikeEvaluation } from './domain/spike-evaluation.js';
export {
  AppFolderDriveClient,
  GRAPH_SIMPLE_UPLOAD_MAX_BYTES,
  GRAPH_UPLOAD_CHUNK_MULTIPLE_BYTES,
  GraphRequestError,
  contentRangeHeader,
  type AppRootInfo,
  type DriveItem,
  type UploadChunkResult,
  type UploadSessionStatus,
} from './graph/graph-client.js';
export {
  GRAPH_AUTHORITY,
  GRAPH_PERSONAL_TENANT,
  GraphTokenError,
  buildAuthorizeUrl,
  createPkcePair,
  exchangeAuthorizationCode,
  graphOAuthEndpoints,
  refreshAccessToken,
  type GraphOAuthConfig,
  type PkcePair,
  type RandomBytes,
  type TokenSet,
} from './graph/oauth.js';
export {
  SPIKE_CHUNKED_FILE_BYTES,
  SPIKE_SIMPLE_FILE_BYTES,
  parseNextExpectedRange,
  runSpikeScenarios,
  type ConsentRevocationObservation,
  type ScenarioDeps,
  type ScenarioDrive,
  type ScenarioTokens,
  type SpikeRunOptions,
} from './harness/scenarios.js';
export { SpikeTokenSession, type SpikeTokenSessionOptions } from './harness/token-session.js';
export { OAuthCallbackError, startLoopbackOAuthServer } from './node/loopback-oauth.js';
export { makeTestFile, nodeRandomBytes, randomHex, sha256Hex } from './node/test-files.js';
