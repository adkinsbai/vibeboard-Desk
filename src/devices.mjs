export function defaultBoardRoots(env = process.env) {
  return {
    targetStatic: env.VIBEBOARD_TARGET_STATIC || "/home/linaro/workspace/taishan-screen/static",
    appRoot: env.VIBEBOARD_APP_ROOT || "/home/linaro/workspace/taishan-screen",
    releaseRoot: env.VIBEBOARD_RELEASE_ROOT || "/home/linaro/workspace/vibeboard-deploy/releases",
    backupRoot: env.VIBEBOARD_BACKUP_ROOT || "/home/linaro/workspace/vibeboard-deploy/backups",
    service: env.VIBEBOARD_BOARD_SERVICE || "taishan-screen.service"
  };
}

export const DEVICE_PROFILES = {
  "taishan-transparent": {
    id: "taishan-transparent",
    label: "透明版",
    host: "150.158.146.192",
    port: "6223",
    frpHost: "150.158.146.192",
    frpPort: "6223",
    user: "linaro"
  },
  "taishan-gray": {
    id: "taishan-gray",
    label: "灰色版",
    host: "150.158.146.192",
    port: "6278",
    frpHost: "150.158.146.192",
    frpPort: "6278",
    user: "linaro"
  },
  "taishan-black": {
    id: "taishan-black",
    label: "亮黑版",
    host: "150.158.146.192",
    port: "6279",
    frpHost: "150.158.146.192",
    frpPort: "6279"
  }
};

export function createBoardConfig(deviceId = undefined, env = process.env) {
  const requestedId = deviceId || env.VIBEBOARD_BOARD_ID || "taishan-gray";
  const base = DEVICE_PROFILES[requestedId] || DEVICE_PROFILES["taishan-gray"];
  const roots = defaultBoardRoots(env);
  const grayOverrides = base.id === "taishan-gray"
    ? {
        host: env.VIBEBOARD_BOARD_HOST || base.host,
        port: env.VIBEBOARD_BOARD_PORT || base.port,
        frpHost: env.VIBEBOARD_FRP_HOST || env.VIBEBOARD_BOARD_HOST || base.frpHost,
        frpPort: env.VIBEBOARD_FRP_PORT || env.VIBEBOARD_BOARD_PORT || base.frpPort
      }
    : {};
  return {
    ...roots,
    ...base,
    ...grayOverrides,
    label: env.VIBEBOARD_BOARD_LABEL || base.label,
    user: env.VIBEBOARD_BOARD_USER || base.user || "root"
  };
}

export function deviceIdFrom(input = {}, fallbackId = "taishan-gray") {
  const id = String(input.deviceId || input.boardId || "").trim();
  if (DEVICE_PROFILES[id]) return id;
  return DEVICE_PROFILES[fallbackId] ? fallbackId : "taishan-gray";
}

export function endpointLabel(endpoint) {
  return `${endpoint.name}:${endpoint.host}:${endpoint.port}`;
}

export function boardEndpoints(board) {
  const preferred = { name: "configured", host: board.host, port: Number(board.port) };
  const frp = { name: "frp", host: board.frpHost, port: Number(board.frpPort) };
  return [frp, preferred].filter((endpoint, index, list) => (
    endpoint.host &&
    endpoint.port &&
    list.findIndex(item => item.host === endpoint.host && item.port === endpoint.port) === index
  ));
}

export function publicBoardConfig(board, runtime = {}) {
  return {
    id: board.id,
    label: board.label,
    host: board.host,
    port: String(board.port),
    user: board.user,
    frpHost: board.frpHost,
    frpPort: String(board.frpPort),
    passwordConfigured: Boolean(runtime.passwordConfigured),
    activeRoute: runtime.activeEndpoint ? endpointLabel(runtime.activeEndpoint) : ""
  };
}

export function publicDeviceProfiles(env = process.env) {
  const roots = defaultBoardRoots(env);
  return Object.values(DEVICE_PROFILES).map(profile => {
    const board = createBoardConfig(profile.id, env);
    return {
      id: profile.id,
      label: profile.label,
      host: board.host,
      port: String(board.port),
      frpHost: board.frpHost,
      frpPort: String(board.frpPort),
      targetStatic: roots.targetStatic
    };
  });
}
