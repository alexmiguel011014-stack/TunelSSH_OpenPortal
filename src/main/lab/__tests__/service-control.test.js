import { describe, expect, it, vi } from 'vitest';
import { createServiceControl, mapServiceState, resolveServiceExe } from '../service-control.js';

const SOURCE = 'C:\\app\\resources\\lab-service\\OpenPortalLabService.exe';
const OWNER = 'S-1-5-21-1-2-3-1001';

function build({
  serviceStatuses = ['missing'],
  statusAnswers = [{ ok: true, state: 'free', studentCount: 0, quota: 'enforce' }],
  exists = () => true,
  elevated = async () => {},
  rdpHosting = true,
} = {}) {
  let statusCalls = 0;
  let pipeCalls = 0;
  const clock = { t: 0 };
  const provisioning = {
    readServiceStatus: vi.fn(
      async () => serviceStatuses[Math.min(statusCalls++, serviceStatuses.length - 1)],
    ),
    readOwnerSid: vi.fn(async () => OWNER),
    verifyRdpHostingEnabled: vi.fn(async () => rdpHosting),
    buildEnableLabScript: vi.fn(() => 'ENABLE'),
    buildDisableLabScript: vi.fn(() => 'DISABLE'),
    runElevatedPowerShell: vi.fn(elevated),
  };
  const client = {
    status: vi.fn(async () => statusAnswers[Math.min(pipeCalls++, statusAnswers.length - 1)]),
  };
  const control = createServiceControl({
    client,
    provisioning,
    serviceSource: SOURCE,
    exists,
    sleep: async (ms) => {
      clock.t += ms;
    },
    now: () => clock.t,
  });
  return { control, provisioning, client };
}

describe('resolveServiceExe', () => {
  it('uses resources/lab-service inside the installed app', () => {
    expect(
      resolveServiceExe({
        moduleDir: 'C:\\Program Files\\OpenPortal Remote\\resources\\app.asar\\src\\main\\lab',
        resourcesPath: 'C:\\Program Files\\OpenPortal Remote\\resources',
      }),
    ).toBe(
      'C:\\Program Files\\OpenPortal Remote\\resources\\lab-service\\OpenPortalLabService.exe',
    );
  });

  it('prefers the Release build in development, falling back to Debug', () => {
    const moduleDir = 'D:\\proj\\src\\main\\lab';
    const release = (p) => p.includes('Release');
    const debug = (p) => p.includes('Debug');
    expect(resolveServiceExe({ moduleDir, exists: () => true })).toMatch(/Release/);
    expect(resolveServiceExe({ moduleDir, exists: debug })).toMatch(/Debug/);
    expect(resolveServiceExe({ moduleDir, exists: release })).toMatch(/Release/);
    expect(resolveServiceExe({ moduleDir, exists: () => false })).toMatch(/Release/);
  });
});

describe('mapServiceState', () => {
  it('maps the service states to the ones lab-status knows', () => {
    expect(mapServiceState('free')).toBe('free');
    expect(mapServiceState('reserved')).toBe('reserved');
    expect(mapServiceState('in-use')).toBe('in-use');
    expect(mapServiceState('ending')).toBe('in-use');
    expect(mapServiceState(undefined)).toBe('free');
    expect(mapServiceState('anything')).toBe('free');
  });
});

describe('getState', () => {
  it('says not installed when there is no service', async () => {
    const { control, client } = build({ serviceStatuses: ['missing'] });
    expect(await control.getState()).toEqual({
      installed: false,
      running: false,
      rdpHosting: true,
      binaryAvailable: true,
      reachable: false,
    });
    expect(client.status).not.toHaveBeenCalled();
  });

  it('reports whether Remote Desktop hosting is ready, and treats a failed check as not ready', async () => {
    const off = build({ serviceStatuses: ['Stopped'], rdpHosting: false });
    expect((await off.control.getState()).rdpHosting).toBe(false);
    const broken = build({ serviceStatuses: ['Stopped'] });
    broken.provisioning.verifyRdpHostingEnabled.mockRejectedValue(new Error('x'));
    expect((await broken.control.getState()).rdpHosting).toBe(false);
  });

  it('says installed but stopped without asking the pipe', async () => {
    const { control, client } = build({ serviceStatuses: ['Stopped'] });
    expect(await control.getState()).toMatchObject({
      installed: true,
      running: false,
      reachable: false,
    });
    expect(client.status).not.toHaveBeenCalled();
  });

  it('reads the service answer when it is running', async () => {
    const { control } = build({
      serviceStatuses: ['Running'],
      statusAnswers: [
        {
          ok: true,
          state: 'reserved',
          studentCount: 3,
          quota: 'enforce',
          reservation: { id: 'r1' },
        },
      ],
    });
    expect(await control.getState()).toMatchObject({
      installed: true,
      running: true,
      reachable: true,
      quota: 'enforce',
      studentCount: 3,
      pcState: 'reserved',
      reservation: { id: 'r1' },
    });
  });

  it('keeps going when the service is running but the pipe does not answer', async () => {
    const { control } = build({
      serviceStatuses: ['Running'],
      statusAnswers: [{ ok: false, error: 'timeout' }],
    });
    expect(await control.getState()).toMatchObject({
      running: true,
      reachable: false,
      error: 'timeout',
    });
  });
});

describe('enable', () => {
  it('builds the script with the owner SID and the on-site option, runs it elevated, and reads back', async () => {
    const { control, provisioning } = build({
      serviceStatuses: ['Running'],
      statusAnswers: [{ ok: true, state: 'free', studentCount: 0, quota: 'enforce' }],
    });
    const result = await control.enable({ studentsOnSite: true });
    expect(result.ok).toBe(true);
    expect(provisioning.buildEnableLabScript).toHaveBeenCalledWith({
      serviceSource: SOURCE,
      ownerSid: OWNER,
      studentsOnSite: true,
    });
    expect(provisioning.runElevatedPowerShell).toHaveBeenCalledWith('ENABLE');
  });

  it('does not offer the on-site option unless it is exactly true', async () => {
    const { control, provisioning } = build({ serviceStatuses: ['Running'] });
    await control.enable({ studentsOnSite: 'yes' });
    expect(provisioning.buildEnableLabScript.mock.calls[0][0].studentsOnSite).toBe(false);
  });

  it('waits for the service to come up before saying it worked', async () => {
    const { control } = build({
      serviceStatuses: ['Stopped', 'Stopped', 'Running'],
      statusAnswers: [{ ok: true, state: 'free', studentCount: 0 }],
    });
    expect((await control.enable()).ok).toBe(true);
  });

  it('reports not-ready when the service never answers', async () => {
    const { control } = build({
      serviceStatuses: ['Running'],
      statusAnswers: [{ ok: false, error: 'service-down' }],
    });
    const result = await control.enable();
    expect(result).toMatchObject({ ok: false, error: 'not-ready' });
    expect(result.message).toContain('service.log');
  });

  it('reports a refused or cancelled UAC prompt', async () => {
    const { control } = build({
      elevated: async () => {
        throw new Error('PowerShell elevado saiu com código 1');
      },
    });
    expect(await control.enable()).toMatchObject({
      ok: false,
      error: 'elevation',
    });
  });

  it('stops before the prompt when the service executable is missing or the owner unknown', async () => {
    const missing = build({ exists: () => false });
    expect(await missing.control.enable()).toMatchObject({
      ok: false,
      error: 'missing-binary',
    });
    expect(missing.provisioning.runElevatedPowerShell).not.toHaveBeenCalled();

    const noOwner = build();
    noOwner.provisioning.readOwnerSid.mockResolvedValue('');
    expect(await noOwner.control.enable()).toMatchObject({
      ok: false,
      error: 'no-owner',
    });
    expect(noOwner.provisioning.runElevatedPowerShell).not.toHaveBeenCalled();
  });

  it('reports a script the builder refuses', async () => {
    const { control, provisioning } = build();
    provisioning.buildEnableLabScript.mockImplementation(() => {
      throw new Error('SID do dono inválido');
    });
    expect(await control.enable()).toMatchObject({
      ok: false,
      error: 'bad-request',
    });
    expect(provisioning.runElevatedPowerShell).not.toHaveBeenCalled();
  });
});

describe('disable', () => {
  it('refuses while a student has the PC reserved or in use', async () => {
    for (const state of ['reserved', 'in-use', 'ending']) {
      const { control, provisioning } = build({
        serviceStatuses: ['Running'],
        statusAnswers: [{ ok: true, state, studentCount: 1 }],
      });
      expect(await control.disable()).toMatchObject({
        ok: false,
        error: 'busy',
      });
      expect(provisioning.runElevatedPowerShell).not.toHaveBeenCalled();
    }
  });

  it('runs the disable script and confirms the service is gone', async () => {
    const { control, provisioning } = build({
      serviceStatuses: ['Running', 'missing'],
      statusAnswers: [{ ok: true, state: 'free', studentCount: 2 }],
    });
    expect((await control.disable()).ok).toBe(true);
    expect(provisioning.runElevatedPowerShell).toHaveBeenCalledWith('DISABLE');
  });

  it('can still be disabled when the service is stopped or not answering', async () => {
    const { control } = build({ serviceStatuses: ['Stopped', 'missing'] });
    expect((await control.disable()).ok).toBe(true);
  });

  it('reports a service that is still there afterwards', async () => {
    const { control } = build({ serviceStatuses: ['Stopped', 'Stopped'] });
    expect(await control.disable()).toMatchObject({
      ok: false,
      error: 'not-removed',
    });
  });

  it('reports a refused UAC prompt', async () => {
    const { control } = build({
      serviceStatuses: ['Stopped'],
      elevated: async () => {
        throw new Error('x');
      },
    });
    expect(await control.disable()).toMatchObject({
      ok: false,
      error: 'elevation',
    });
  });
});

describe('hostStatusInput (what lab-status asks the service)', () => {
  it('reports the PC state, the student and the disk from the service', async () => {
    const { control } = build({
      statusAnswers: [
        {
          ok: true,
          state: 'in-use',
          studentCount: 4,
          reservation: {
            label: 'Ana',
            createdAt: 100,
            firstLogonAt: 200,
            endsAt: 900,
          },
          disk: { totalGb: 250, freeGb: 120, usedByStudentsGb: 10 },
        },
      ],
    });
    expect(await control.hostStatusInput()).toEqual({
      service: { installed: true, running: true },
      state: 'in-use',
      studentCount: 4,
      student: { label: 'Ana', since: 200, endsAt: 900 },
      disk: { totalGb: 250, freeGb: 120 },
    });
  });

  it('uses the reservation time as "since" while the student has not signed in yet', async () => {
    const { control } = build({
      statusAnswers: [
        {
          ok: true,
          state: 'reserved',
          studentCount: 1,
          reservation: {
            label: 'Ana',
            createdAt: 100,
            firstLogonAt: 0,
            endsAt: 900,
          },
        },
      ],
    });
    const input = await control.hostStatusInput();
    expect(input.state).toBe('reserved');
    expect(input.student).toEqual({ label: 'Ana', since: 100, endsAt: 900 });
  });

  it('never passes a password or anything the service did not name', async () => {
    const { control } = build({
      statusAnswers: [
        {
          ok: true,
          state: 'free',
          studentCount: 0,
          password: 'S3cret',
          students: [{ account: 'ana', password: 'x' }],
        },
      ],
    });
    expect(JSON.stringify(await control.hostStatusInput())).not.toMatch(/S3cret|password|students/);
  });

  it('without the pipe, only says whether the service is installed, and asks Windows at most every 30 s', async () => {
    const { control, provisioning } = build({
      serviceStatuses: ['Stopped'],
      statusAnswers: [{ ok: false, error: 'service-down' }],
    });
    expect(await control.hostStatusInput()).toEqual({
      service: { installed: true, running: false },
    });
    await control.hostStatusInput();
    await control.hostStatusInput();
    expect(provisioning.readServiceStatus).toHaveBeenCalledTimes(1);
  });

  it('says not installed when there is no service at all', async () => {
    const { control } = build({
      serviceStatuses: ['missing'],
      statusAnswers: [{ ok: false, error: 'service-down' }],
    });
    expect(await control.hostStatusInput()).toEqual({
      service: { installed: false, running: false },
    });
  });
});
