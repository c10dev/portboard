// Portboard's own systemd user units: portboard.service and the units install-service writes next to it
// (portboard-remote.service, portboard-agent.service). Stop refuses them, and the new-port and idle checks treat them
// as Portboard itself. Pure, so newports.ts and suggest.ts can share it without the control layer.

export const PORTBOARD_UNIT = /^portboard(?:-[a-z]+)?\.service$/;

export const isPortboardUnit = (unit: string | null | undefined): boolean => !!unit && PORTBOARD_UNIT.test(unit);

/** A port held by this process or by one of Portboard's units */
export const isPortboardProcess = (processes: readonly { pid: number; unit?: string | null }[], selfPid = process.pid): boolean =>
  processes.some((p) => p.pid === selfPid || isPortboardUnit(p.unit));
