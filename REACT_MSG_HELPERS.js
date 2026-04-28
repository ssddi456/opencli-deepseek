/** Shared JS helpers injected into page.evaluate for React props extraction. */
export const REACT_MSG_HELPERS = `
  var __log = [];
  function __getReactProps(el) {
    const key = Object.keys(el).find(k => k.startsWith('__reactProps$'));
    __log.push('React props key: ' + key);
    return key ? el[key] : null;
  }
  function __extractCiteContent(p) {
    if (!p || p.content === undefined) return null;
    if (p.citeProps === undefined && p.cacheKey === undefined) return null;
    if (p.loading) {
      __log.push('cite/cache shape: loading=true, skipping');
      return { loading: true, content: null };
    }
    __log.push('Found message in cite/cache shape: ' + p.content);
    return { loading: false, content: p.content };
  }
  function __getMessageContent(node) {
    try {
      const prop = __getReactProps(node);
      if (!prop) return null;
      // BFS through the React props tree
      var queue = [prop];
      while (queue.length > 0) {
        var p = queue.shift();
        if (!p) continue;
        var citeResult = __extractCiteContent(p);
        if (citeResult) return citeResult;
        if (p.response?.message) {
          __log.push('Found message in props.response: ' + p.response.message);
          return { loading: false, content: p.response.message };
        }
        if (p.value?.message) {
          __log.push('Found message in props.value: ' + p.value.message);
          return { loading: false, content: p.value.message };
        }
        // Enqueue children
        if (Array.isArray(p.children)) {
          for (var i = 0; i < p.children.length; i++) {
            var child = p.children[i];
            if (child?.props) queue.push(child.props);
          }
        } else if (p.children?.props) {
          queue.push(p.children.props);
        }
      }
      return null;
    } catch (e) { __log.push('__getMessageContent error: ' + e); return null; }
  }
  function __findMessageInDomTree(element) {
    let current = element;
    while (current) {
      const content = __getMessageContent(current);
      if (content) return content;
      current = current.parentElement;
    }
    return null;
  }
`;
