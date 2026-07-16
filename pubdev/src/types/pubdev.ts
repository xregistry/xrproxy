/**
 * pub.dev-specific type definitions
 */

export interface PubDevPackageNamesResponse {
  packages: string[];
}

export interface PubspecEnvironment {
  sdk?: string;
  flutter?: string;
}

export interface Pubspec {
  name: string;
  version?: string;
  description?: string;
  homepage?: string;
  repository?: string | { url?: string };
  issue_tracker?: string;
  documentation?: string;
  environment?: PubspecEnvironment;
  dependencies?: Record<string, unknown>;
  dev_dependencies?: Record<string, unknown>;
  topics?: string[];
  platforms?: Record<string, unknown>;
}

export interface PubDevVersion {
  version: string;
  pubspec: Pubspec;
  archive_url: string;
  archive_sha256?: string;
  published: string;
  retracted?: boolean;
}

export interface PubDevPackageResponse {
  name: string;
  latest: PubDevVersion;
  versions: PubDevVersion[];
  isDiscontinued?: boolean;
  replacedBy?: string;
}

export interface PubDevScore {
  grantedPoints: number;
  maxPoints: number;
  likeCount: number;
  popularityScore: number;
  tags?: string[];
}

export interface PubDevPublisher {
  publisherId?: string;
}
