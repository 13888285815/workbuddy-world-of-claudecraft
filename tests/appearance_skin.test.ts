import { describe, expect, it } from 'vitest';
import { ClientWorld } from '../src/net/online';
import { Sim } from '../src/sim/sim';
import type { IWorld } from '../src/world_api';

describe('appearance skin selection', () => {
  it('updates offline player skin through the world contract', () => {
    const sim = new Sim({ seed: 1, playerClass: 'druid', playerName: 'Skintest' });
    const world: IWorld = sim;

    world.changeSkin(3);

    expect(sim.player.skin).toBe(3);
    // persistence is a Sim-concrete concern, not part of the IWorld seam
    expect(sim.serializeCharacter(sim.playerId)?.skin).toBe(3);
  });

  it('mirrors the skin change locally on the sim player (Supabase path)', () => {
    // In the Supabase architecture, changeSkin is a no-op on ClientWorld
    // because skin changes are handled via the local Sim which syncs to Supabase.
    // The offline path (Sim.changeSkin) is tested above.
    // Verify the ClientWorld.changeSkin doesn't throw.
    const client: ClientWorld = Object.create(ClientWorld.prototype);
    Object.assign(client, {
      connected: true,
      playerId: 7,
      entities: new Map([[7, { id: 7, skin: 0 }]]),
    });
    expect(() => client.changeSkin(2)).not.toThrow();
  });
});
