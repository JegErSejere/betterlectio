import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { DOMParser } from 'linkedom';
import { parseCurrentFolder } from './dokumenter-parser';

function documentFor(html: string, href: string): Document {
  const doc = new DOMParser().parseFromString(
    `<html><body>${html}</body></html>`,
    'text/html',
  ) as unknown as Document;
  Object.defineProperty(doc, 'location', { value: { href }, configurable: true });
  return doc;
}

describe('document folder parsing', () => {
  test('uses Lectio tree selection when postbacks leave folderid out of the URL', () => {
    const doc = documentFor(`
      <div id="s_m_Content_Content_FolderTreeView">
        <div lec-role="treeviewnodecontainer" lec-node-id="S123__">
          <div class="TreeNode-container">
            <a class="TreeNode selectedFolder" lec-command="ltv-selectnode">Egne dokumenter</a>
          </div>
        </div>
      </div>
      <span id="s_m_Content_Content_FolderLabel">Egne dokumenter</span>
    `, 'https://www.lectio.dk/lectio/94/DokumentOversigt.aspx');

    assert.equal(parseCurrentFolder(doc).folderId, 'S123__');
  });

  test('prefers current tree state over a stale folderid query parameter', () => {
    const doc = documentFor(`
      <div id="s_m_Content_Content_FolderTreeView">
        <div lec-role="treeviewnodecontainer" lec-node-id="S456__7">
          <div class="TreeNode-container">
            <a class="TreeNode selectedFolder" lec-command="ltv-selectnode">Ny mappe</a>
          </div>
        </div>
      </div>
    `, 'https://www.lectio.dk/lectio/94/DokumentOversigt.aspx?folderid=S123__');

    assert.equal(parseCurrentFolder(doc).folderId, 'S456__7');
  });

  test('retains folderid URL support when no tree selection is rendered', () => {
    const doc = documentFor(
      '',
      'https://www.lectio.dk/lectio/94/DokumentOversigt.aspx?folderid=S789__',
    );

    assert.equal(parseCurrentFolder(doc).folderId, 'S789__');
  });
});
