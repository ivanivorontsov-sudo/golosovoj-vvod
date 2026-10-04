import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import Quill from 'quill';
import { EditorState as PMState } from 'prosemirror-state';
import { EditorView } from 'prosemirror-view';
import { schema } from 'prosemirror-schema-basic';
import { exampleSetup } from 'prosemirror-example-setup';
import { createEditor, $getRoot } from 'lexical';
import { registerRichText } from '@lexical/rich-text';
import { Editor, EditorState } from 'draft-js';

function ReactInput() {
  const [v, setV] = useState('');
  return <div><input id="react-inp" value={v} onChange={e => setV(e.target.value)} placeholder="React controlled" />
    <span id="react-mirror">{v}</span></div>;
}
function DraftBox() {
  const [st, setSt] = useState(() => EditorState.createEmpty());
  window.draftText = () => st.getCurrentContent().getPlainText('\n');
  return <div id="draft" style={{ border: '1px solid #999', minHeight: 40 }}><Editor editorState={st} onChange={setSt} placeholder="Draft.js" /></div>;
}
createRoot(document.getElementById('react-root')).render(<ReactInput />);
createRoot(document.getElementById('draft-root')).render(<DraftBox />);

window.quill = new Quill('#quill', { theme: 'snow' });
window.quillText = () => window.quill.getText().replace(/\n$/, '');

window.pmView = new EditorView(document.getElementById('pm'), {
  state: PMState.create({ schema, plugins: exampleSetup({ schema, menuBar: false }) })
});
window.pmText = () => window.pmView.state.doc.textBetween(0, window.pmView.state.doc.content.size, '\n');

const lex = createEditor({ namespace: 't', onError: e => console.error(e) });
lex.setRootElement(document.getElementById('lexical'));
registerRichText(lex);
window.lexicalEditor = lex;
window.lexText = () => lex.getEditorState().read(() => $getRoot().getTextContent());
