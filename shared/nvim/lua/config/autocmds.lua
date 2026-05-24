local augroup = vim.api.nvim_create_augroup
local autocmd = vim.api.nvim_create_autocmd

-- ─── Highlight on yank ────────────────────────────────────────────────────────
autocmd("TextYankPost", {
  group = augroup("highlight_yank", { clear = true }),
  callback = function()
    vim.highlight.on_yank({ higroup = "IncSearch", timeout = 200 })
  end,
})

-- ─── Close certain buffers with just 'q' ─────────────────────────────────────
autocmd("FileType", {
  group = augroup("close_with_q", { clear = true }),
  pattern = { "help", "man", "qf", "checkhealth", "lspinfo", "startuptime", "notify" },
  callback = function(event)
    vim.bo[event.buf].buflisted = false
    vim.keymap.set("n", "q", "<cmd>close<cr>", { buffer = event.buf, silent = true })
  end,
})

-- ─── Auto-resize splits when terminal is resized ─────────────────────────────
autocmd("VimResized", {
  group = augroup("resize_splits", { clear = true }),
  callback = function()
    local current_tab = vim.fn.tabpagenr()
    vim.cmd("tabdo wincmd =")
    vim.cmd("tabnext " .. current_tab)
  end,
})

-- ─── Return to last cursor position when reopening a file ────────────────────
autocmd("BufReadPost", {
  group = augroup("last_cursor_position", { clear = true }),
  callback = function(event)
    local exclude = { "gitcommit" }
    local buf = event.buf
    if vim.tbl_contains(exclude, vim.bo[buf].filetype) then return end
    local mark = vim.api.nvim_buf_get_mark(buf, '"')
    local lcount = vim.api.nvim_buf_line_count(buf)
    if mark[1] > 0 and mark[1] <= lcount then
      pcall(vim.api.nvim_win_set_cursor, 0, mark)
    end
  end,
})

-- ─── Remove trailing whitespace on save ───────────────────────────────────────
autocmd("BufWritePre", {
  group = augroup("trim_whitespace", { clear = true }),
  callback = function()
    local save = vim.fn.winsaveview()
    vim.cmd([[%s/\s\+$//e]])
    vim.fn.winrestview(save)
  end,
})
