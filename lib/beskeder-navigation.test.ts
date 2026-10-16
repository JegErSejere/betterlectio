import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { shouldRedirectMessagesToNewest } from './beskeder-navigation';

describe('shouldRedirectMessagesToNewest', () => {
  test('redirects only the bare messages landing page', () => {
    assert.equal(shouldRedirectMessagesToNewest('/lectio/94/beskeder2.aspx', '', true), true);
    assert.equal(shouldRedirectMessagesToNewest('/lectio/94/Beskeder2.aspx', '?', true), true);
  });

  test('preserves Lectio message states', () => {
    assert.equal(
      shouldRedirectMessagesToNewest(
        '/lectio/94/beskeder2.aspx',
        '?type=visbesked&id=83499380720',
        true,
      ), false,
    );
    assert.equal(
      shouldRedirectMessagesToNewest('/lectio/94/beskeder2.aspx', '?mappeid=-70', true),
      false,
    );
    assert.equal(
      shouldRedirectMessagesToNewest('/lectio/94/beskeder2.aspx', '?type=nybesked', true),
      false,
    );
  });

  test('respects the setting and page path', () => {
    assert.equal(shouldRedirectMessagesToNewest('/lectio/94/beskeder2.aspx', '', false), false);
    assert.equal(shouldRedirectMessagesToNewest('/lectio/94/forside.aspx', '', true), false);
  });
});
