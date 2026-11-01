/*
 * GoRead WiFi 传书网页端脚本（原生 JS）
 *
 * 页面结构：上传按钮（含隐藏 file input）/ 创建分组 / Refresh；
 * 上传进度面板（File Uploads in Progress）；「导入到分组」下拉 + 已传文件列表面板；创建分组弹窗。
 * 接口对接本服务：/api/list、/api/groups、/api/groups/create、/api/delete、/upload、/download。
 * 分组数据与电脑端本地书架同源（同一 SQLite）：网页端建组即在书架同步生成，
 * 上传时选择的分组即书籍导入书架后的目标分组。
 */
(function () {
  'use strict';

  var ENTER_KEYCODE = 13;

  /* 重载禁用期间的待处理重载标志（对齐参考页的串行化刷新机制） */
  var _pendingReloads = [];
  /* 重载禁用计数（刷新进行中时暂停其他刷新请求） */
  var _reloadingDisabled = 0;
  /* 进行中的上传请求数（>0 时暂停自动刷新） */
  var _uploading = 0;

  /**
   * 简化版选择器：返回第一个匹配元素
   *
   * 参数：sel CSS 选择器；root 查找根元素（默认 document）
   * 返回值：匹配的元素或 null
   */
  function $(sel, root) {
    return (root || document).querySelector(sel);
  }

  /**
   * 简化版选择器：返回全部匹配元素数组
   *
   * 参数：sel CSS 选择器；root 查找根元素（默认 document）
   * 返回值：匹配元素数组
   */
  function $all(sel, root) {
    return Array.prototype.slice.call((root || document).querySelectorAll(sel));
  }

  /**
   * HTML 转义（防注入）
   *
   * 参数：s 原始字符串
   * 返回值：转义后的安全字符串
   */
  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  /**
   * 文件大小格式化（1000 进制、两位小数，小于 1MB 一律显示 KB）
   *
   * 参数：bytes 字节数
   * 返回值：如 "2.74 MB" 的格式化文本
   */
  function formatFileSize(bytes) {
    if (bytes >= 1000000000) {
      return (bytes / 1000000000).toFixed(2) + ' GB';
    }
    if (bytes >= 1000000) {
      return (bytes / 1000000).toFixed(2) + ' MB';
    }
    return (bytes / 1000).toFixed(2) + ' KB';
  }

  /**
   * 追加一条 Bootstrap 提示条（可手动关闭）
   *
   * 参数：level 提示级别（danger/warning/success）；title 加粗标题；description 正文
   * 返回值：无
   */
  function _showAlert(level, title, description) {
    var div = document.createElement('div');
    div.className = 'alert alert-' + level + ' alert-dismissable';
    div.innerHTML = '<button type="button" class="close">&times;</button>' +
      '<strong>' + esc(title) + '</strong>' + esc(description);
    div.querySelector('.close').addEventListener('click', function () { div.remove(); });
    $('#alerts').prepend(div);
  }

  /**
   * 追加一条错误提示条
   *
   * 参数：message 错误描述；textStatus 状态描述；errorThrown 错误摘要
   * 返回值：无
   */
  function _showError(message, textStatus, errorThrown) {
    _showAlert('danger', ((errorThrown && errorThrown !== '') ? errorThrown : textStatus) + ': ', message);
  }

  /**
   * 禁用列表刷新（避免刷新请求并发堆积）
   *
   * 返回值：无
   */
  function _disableReloads() {
    _reloadingDisabled += 1;
  }

  /**
   * 重新启用列表刷新；若有挂起的重载请求则立即执行
   *
   * 返回值：无
   */
  function _enableReloads() {
    _reloadingDisabled -= 1;
    if (_reloadingDisabled <= 0 && _pendingReloads.length > 0) {
      _pendingReloads = [];
      _reload();
    }
  }

  /**
   * 拉取已传文件列表并渲染（服务端只返回文件条目，无目录层级）
   *
   * 参数：无
   * 返回值：无
   */
  function _reload() {
    if (_reloadingDisabled > 0) {
      if (_pendingReloads.length === 0) {
        _pendingReloads.push(true);
      }
      return;
    }

    _disableReloads();
    fetch('/api/list')
      .then(function (r) {
        if (!r.ok) { throw new Error('HTTP ' + r.status); }
        return r.json();
      })
      .then(function (data) {
        var scrollPosition = window.pageYOffset;
        renderListing(data.entries || []);
        window.scrollTo(0, scrollPosition);
      })
      .catch(function (err) {
        // 服务不可达时清空列表：避免残留过期记录让用户误以为还有已传输文件
        $('#listing').innerHTML = '';
        _showError('获取已传文件列表失败', 'Error', err.message);
      })
      .finally(function () {
        _enableReloads();
      });
  }

  /**
   * 拉取电脑书架全量分组并填充「导入到分组」下拉（含空分组；保持当前已选项）
   *
   * 参数：无
   * 返回值：Promise（便于建组后链式刷新）
   */
  function loadGroups() {
    /* 用户正在操作下拉时跳过本轮刷新，避免打断选择 */
    var select = $('#group-select');
    if (document.activeElement === select) { return Promise.resolve(); }

    return fetch('/api/groups')
      .then(function (r) {
        if (!r.ok) { throw new Error('HTTP ' + r.status); }
        return r.json();
      })
      .then(function (data) {
        var groups = data.groups || [];
        var current = select.value;
        var html = '<option value="">不分组</option>';
        groups.forEach(function (g) {
          html += '<option value="' + esc(g.id) + '">' + esc(g.name) + '</option>';
        });
        select.innerHTML = html;
        /* 已选分组仍存在时保持选中，否则回退「不分组」 */
        var stillExists = groups.some(function (g) { return String(g.id) === current; });
        select.value = stillExists ? current : '';
      })
      .catch(function () {
        /* 分组拉取失败时静默：文件列表刷新已弹出错误提示，此处避免重复噪音 */
      });
  }

  /**
   * 渲染已传文件列表（行结构：下载/名称/大小/删除）
   *
   * 参数：entries 服务端条目数组 [{name, size}]
   * 返回值：无
   */
  function renderListing(entries) {
    var tbody = $('#listing');
    tbody.innerHTML = '';

    entries.forEach(function (it) {
      var tr = document.createElement('tr');
      tr.className = 'row-file';
      tr.setAttribute('data-path', it.name);

      tr.innerHTML =
        '<td class="column-icon"><button type="button" class="btn btn-default btn-xs button-download" title="下载"><span class="glyphicon glyphicon-download-alt"></span></button></td>' +
        '<td class="column-name"><p>' + esc(it.name) + '</p></td>' +
        '<td class="column-size"><p>' + esc(formatFileSize(it.size || 0)) + '</p></td>' +
        '<td class="column-delete"><button type="button" class="btn btn-danger btn-xs button-delete" title="删除"><span class="glyphicon glyphicon-trash"></span></button></td>';
      tbody.appendChild(tr);
    });

    bindRowHandlers(tbody);
  }

  /**
   * 为列表行绑定交互（下载/删除）
   *
   * 参数：root 列表 tbody 根元素
   * 返回值：无
   */
  function bindRowHandlers(root) {
    $all('.button-download', root).forEach(function (btn) {
      btn.addEventListener('click', function () {
        var path = btn.closest('tr').getAttribute('data-path');
        setTimeout(function () {
          window.location = '/download?path=' + encodeURIComponent(path);
        }, 0);
      });
    });

    $all('.button-delete', root).forEach(function (btn) {
      btn.addEventListener('click', function () {
        var path = btn.closest('tr').getAttribute('data-path');
        /* 加确认对话框以防误删（安全加固） */
        if (!window.confirm('确定删除 "' + path + '" ？')) { return; }
        fetch('/api/delete', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ path: path })
        })
          .then(function (r) {
            if (!r.ok) { throw new Error('HTTP ' + r.status); }
          })
          .catch(function (err) {
            _showError('删除 "' + path + '" 失败', 'Error', err.message);
          })
          .finally(function () {
            _reload();
          });
      });
    });
  }

  /**
   * 显示 Bootstrap 风格弹窗（原生实现：backdrop + .in 过渡）
   *
   * 参数：modal 弹窗根元素
   * 返回值：无
   */
  function showModal(modal) {
    var backdrop = document.createElement('div');
    backdrop.className = 'modal-backdrop fade in';
    document.body.appendChild(backdrop);
    document.body.classList.add('modal-open');
    modal.style.display = 'block';
    /* 触发一次回流以播放淡入过渡 */
    void modal.offsetHeight;
    modal.classList.add('in');
    var input = modal.querySelector('input[type="text"]');
    if (input) {
      setTimeout(function () { input.focus(); input.select(); }, 150);
    }
  }

  /**
   * 隐藏 Bootstrap 风格弹窗并清理 backdrop
   *
   * 参数：modal 弹窗根元素
   * 返回值：无
   */
  function hideModal(modal) {
    modal.classList.remove('in');
    modal.style.display = 'none';
    $all('.modal-backdrop').forEach(function (b) { b.remove(); });
    document.body.classList.remove('modal-open');
  }

  /**
   * 批量上传：逐个文件串行上传
   *
   * 参数：fileList FileList 或 File 数组
   * 返回值：无
   */
  function uploadFiles(fileList) {
    var files = Array.prototype.slice.call(fileList || []);
    if (!files.length) { return; }

    _uploading += files.length;
    $('.uploading').style.display = 'block';

    var chain = Promise.resolve();
    files.forEach(function (file) {
      chain = chain.then(function () { return uploadOne(file); });
    });
    chain.then(function () {
      _uploading = 0;
      $('.uploading').style.display = '';
      _reload();
    });
  }

  /**
   * 上传单个文件：创建进度行、支持取消、携带所选分组、完成后按结果给出提示
   *
   * 参数：file 待上传的 File 对象
   * 返回值：Promise（上传结束（含失败/取消）后 resolve）
   */
  function uploadOne(file) {
    return new Promise(function (resolve) {
      var row = document.createElement('tr');
      row.className = 'row-file';
      row.innerHTML =
        '<td class="column-icon"><button type="button" class="btn btn-warning btn-xs button-cancel" title="取消"><span class="glyphicon glyphicon-ban-circle"></span></button></td>' +
        '<td class="column-path"><p>' + esc(file.name) + '</p></td>' +
        '<td class="column-progress"><div class="progress"><div class="progress-bar" style="width:0%"></div></div></td>';
      $('#uploads').appendChild(row);

      var bar = row.querySelector('.progress-bar');
      var fd = new FormData();
      /* 分组字段须先于文件字段追加；空值表示不分组 */
      fd.append('group_id', $('#group-select').value || '');
      fd.append('files', file, file.name);

      var xhr = new XMLHttpRequest();
      row.querySelector('.button-cancel').addEventListener('click', function () { xhr.abort(); });
      xhr.open('POST', '/upload');
      xhr.upload.onprogress = function (e) {
        if (e.lengthComputable) {
          bar.style.width = Math.floor(e.loaded / e.total * 100) + '%';
        }
      };
      xhr.onload = function () {
        row.remove();
        if (xhr.status >= 200 && xhr.status < 300) {
          try {
            var res = JSON.parse(xhr.responseText);
            if (res.skipped && res.skipped.length) {
              _showAlert('warning', '已跳过 ' + res.skipped.length + ' 个不支持的文件类型：', res.skipped.join('，'));
            }
          } catch (e2) { /* 响应非 JSON 时忽略 */ }
        } else {
          _showAlert('danger', '上传失败 "' + file.name + '"：', 'HTTP ' + xhr.status);
        }
        resolve();
      };
      xhr.onerror = function () {
        row.remove();
        _showAlert('danger', '上传失败 "' + file.name + '"：', '网络错误');
        resolve();
      };
      xhr.onabort = function () {
        row.remove();
        resolve();
      };
      xhr.send(fd);
    });
  }

  /* ===== 事件绑定 ===== */

  /* 上传按钮触发隐藏 file input（规避部分浏览器不弹出选择框的问题） */
  $('#upload-file').addEventListener('click', function () {
    $('#fileupload').click();
  });
  /* 阻止 file input 点击冒泡到上传按钮导致二次触发 */
  $('#fileupload').addEventListener('click', function (e) {
    e.stopPropagation();
  });
  $('#fileupload').addEventListener('change', function () {
    if (this.files && this.files.length) {
      uploadFiles(this.files);
    }
    this.value = '';
  });

  /* 全页拖拽上传 */
  document.addEventListener('dragover', function (e) {
    e.preventDefault();
  });
  document.addEventListener('drop', function (e) {
    e.preventDefault();
    if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length) {
      uploadFiles(e.dataTransfer.files);
    }
  });

  /* 创建分组弹窗 */
  $('#create-folder').addEventListener('click', function () {
    $('#create-input').value = '新建分组';
    showModal($('#create-modal'));
  });
  $('#create-confirm').addEventListener('click', function () {
    hideModal($('#create-modal'));
    var name = $('#create-input').value.trim();
    if (!name) { return; }
    fetch('/api/groups/create', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: name })
    })
      .then(function (r) {
        if (r.status === 409) { throw new Error('分组名称已存在'); }
        if (!r.ok) { throw new Error('HTTP ' + r.status); }
        return r.json();
      })
      .then(function () {
        _showAlert('success', '分组 "' + name + '" 创建成功：', '手机与电脑书架已同步生成该分组');
        return loadGroups();
      })
      .catch(function (err) {
        _showError('创建分组 "' + name + '" 失败', 'Error', err.message);
      });
  });
  $('#create-input').addEventListener('keypress', function (e) {
    if (e.keyCode === ENTER_KEYCODE) {
      $('#create-confirm').click();
    }
  });

  /* 弹窗关闭按钮与 Esc 键 */
  $all('[data-dismiss="modal"]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      hideModal(btn.closest('.modal'));
    });
  });
  document.addEventListener('keydown', function (e) {
    if (e.keyCode === 27) {
      $all('.modal.in').forEach(hideModal);
    }
  });

  /* Refresh 按钮：同时刷新文件列表与分组下拉 */
  $('#reload').addEventListener('click', function () {
    _reload();
    loadGroups();
  });

  /* 自动刷新（同局域网多设备操作后列表与分组自动更新；上传/刷新/弹窗期间暂停） */
  setInterval(function () {
    if (_uploading > 0 || _reloadingDisabled > 0 || document.hidden) { return; }
    if ($('.modal.in')) { return; }
    _reload();
    loadGroups();
  }, 3000);

  /* 初始加载：文件列表 + 书架全量分组 */
  _reload();
  loadGroups();
})();
