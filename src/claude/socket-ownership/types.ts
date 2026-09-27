export type OwnerRecord = {
  pid: number;
  identity?: string;
  generation?: string;
};

export type FileIdentity = {
  dev: bigint;
  ino: bigint;
};

export type FileGeneration = FileIdentity & { ctimeNs: bigint };

export type SocketIdentity = FileIdentity & { ctimeNs: bigint; birthtimeNs: bigint };

export type OwnerMarkerSnapshot = {
  owner: OwnerRecord;
  identity: FileGeneration;
};
