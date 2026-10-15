const { htmlToText, decodeEntities } = require('../../../services/htmlToText');

describe('htmlToText', () => {
  test('keeps the words, drops scripts, styles, comments and the head', () => {
    const html = '<html><head><title>Page</title><style>p{}</style></head>'
      + '<body><!-- hidden --><script>fetch("/x")</script><noscript>enable js</noscript>'
      + '<h1>Title</h1><p>First <b>bold</b> line.</p><div>Second</div></body></html>';

    expect(htmlToText(html)).toBe('Title\nFirst bold line.\nSecond');
  });

  test('block boundaries separate lines; inline tags do not', () => {
    expect(htmlToText('<ul><li>one</li><li>two <a href="/x">link</a></li></ul>')).toBe('one\ntwo link');
    expect(htmlToText('a<br>b<br/>c')).toBe('a\nb\nc');
  });

  test('runs of whitespace collapse and empty lines are dropped', () => {
    expect(htmlToText('<p>  spaced \t\n out </p><p></p><p></p><p>next</p>')).toBe('spaced\nout\nnext');
  });

  test('an unclosed script runs to the end of the input, as a browser would treat it', () => {
    expect(htmlToText('<p>before</p><script>never closed <p>not text</p>')).toBe('before');
  });

  test('svg, iframe, object and template content is dropped', () => {
    expect(htmlToText('<p>a</p><svg><text>x</text></svg><iframe src="/e">y</iframe><object>z</object><template>t</template><p>b</p>'))
      .toBe('a\nb');
  });

  test('a stray "<" that opens no tag stays as text', () => {
    expect(htmlToText('<p>1 < 2 and 3 > 2</p>')).toBe('1 < 2 and 3 > 2');
  });
});

describe('decodeEntities', () => {
  test('named, decimal and hex entities decode', () => {
    expect(decodeEntities('&amp; &lt;b&gt; &quot;q&quot; &#39;s&#39; &#x41;&#66; &mdash; &nbsp;')).toBe('& <b> "q" \'s\' AB —  ');
  });

  test('an unknown named entity is left as written', () => {
    expect(decodeEntities('&notanentity; &amp')).toBe('&notanentity; &amp');
  });

  test('NUL, surrogates and out-of-range code points decode to nothing', () => {
    expect(decodeEntities('a&#0;b&#xD800;c&#x110000;d')).toBe('abcd');
  });
});
