jest.mock('../../../models/DeviceAuthorization', () => ({ create: jest.fn() }));

const DeviceAuthorization = require('../../../models/DeviceAuthorization');
const { createDeviceAuthorization } = require('../../../services/deviceAuthorizationService');

describe('createDeviceAuthorization text fields', () => {
  beforeEach(() => {
    DeviceAuthorization.create.mockReset();
    DeviceAuthorization.create.mockResolvedValue({});
  });

  it('stores what a person approving will read, with nothing that changes how it reads', async () => {
    await createDeviceAuthorization({
      clientName: 'Commonly​ CLI\n',
      clientVersion: '0.1­.289\t',
      hostname: 'work-mac‮oob⁦-laptop ',
    });
    expect(DeviceAuthorization.create).toHaveBeenCalledWith(expect.objectContaining({
      clientName: 'Commonly CLI',
      clientVersion: '0.1.289',
      hostname: 'work-macoob-laptop',
    }));
  });

  it('leaves a plain name alone, accents and spaces included', async () => {
    await createDeviceAuthorization({ clientName: 'Commonly CLI', hostname: 'Zoë’s MacBook Pro' });
    expect(DeviceAuthorization.create).toHaveBeenCalledWith(expect.objectContaining({
      hostname: 'Zoë’s MacBook Pro',
    }));
  });

  it('refuses a name with nothing left to show', async () => {
    await expect(createDeviceAuthorization({ clientName: 'cli', hostname: '‮​' }))
      .rejects.toThrow('clientName and hostname are required');
    expect(DeviceAuthorization.create).not.toHaveBeenCalled();
  });
});
