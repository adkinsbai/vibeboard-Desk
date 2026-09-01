export function defaultBoardRoots(env = process.env) {
  return {
    targetStatic: env.VIBEBOARD_TARGET_STATIC || "/home/linaro/workspace/taishan-screen/static",
    appRoot: env.VIBEBOARD_APP_ROOT || "/home/linaro/workspace/taishan-screen",
    releaseRoot: env.VIBEBOARD_RELEASE_ROOT || "/home/linaro/workspace/vibeboard-deploy/releases",
    backupRoot: env.VIBEBOARD_BACKUP_ROOT || "/home/linaro/workspace/vibeboard-deploy/backups",
    service: env.VIBEBOARD_BOARD_SERVICE || "taishan-screen.service",
    kioskUrl: env.VIBEBOARD_KIOSK_URL || "http://127.0.0.1:8765/",
    statusUrl: env.VIBEBOARD_BOARD_STATUS_URL || "http://127.0.0.1:8765/api/status"
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
    frpPort: "6279",
    user: "linaro"
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

export function boardConfigForBoundDevice(device = {}, env = process.env) {
  const board = createBoardConfig(device.board_id || device.boardId || "taishan-gray", env);
  const connection = device.connection && typeof device.connection === "object" ? device.connection : {};
  const connectionMode = String(connection.mode || (connection.host || connection.frpHost ? "frp" : "preview")).trim() || "preview";
  const shared = {
    ...board,
    id: device.board_id || device.boardId || board.id,
    label: device.label || board.label,
    connectionMode,
  };

  if (connectionMode === "preview") {
    return {
      ...shared,
      host: "",
      port: "",
      frpHost: "",
      frpPort: "",
      deployable: false,
    };
  }

  const host = connection.host || connection.lanHost || board.host;
  const port = connection.port || connection.lanPort || board.port;
  const frpHost = connection.frpHost || (connectionMode === "frp" ? connection.host : board.frpHost);
  const frpPort = connection.frpPort || (connectionMode === "frp" ? connection.port : board.frpPort);
  return {
    ...shared,
    host,
    port,
    frpHost,
    frpPort,
    user: connection.user || board.user,
    kioskUrl: connection.kioskUrl || board.kioskUrl,
    statusUrl: connection.statusUrl || board.statusUrl,
    deployable: true,
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
  if (board?.connectionMode === "preview" || board?.deployable === false) {
    return [];
  }
  const preferred = { name: "configured", host: board.host, port: Number(board.port) };
  const frp = { name: "frp", host: board.frpHost, port: Number(board.frpPort) };
  return [preferred, frp].filter((endpoint, index, list) => (
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
    kioskUrl: board.kioskUrl,
    statusUrl: board.statusUrl,
    connectionMode: board.connectionMode || "real",
    deployable: board.deployable !== false,
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
      kioskUrl: board.kioskUrl,
      statusUrl: board.statusUrl,
      targetStatic: roots.targetStatic
    };
  });
}
