return {
  "akinsho/toggleterm.nvim",
  version = "*",
  lazy = false,
  config = function()
    require("toggleterm").setup({
      persist_size = true,
      persist_mode = true,
      start_in_insert = true,
      shade_terminals = false,
    })

    local Terminal = require("toggleterm.terminal").Terminal

    local opencode = Terminal:new({
      cmd = "opencode",
      direction = "float",
      close_on_exit = true,
      float_opts = {
        border = "rounded",
        width = function()
          return math.floor(vim.o.columns * 0.80)
        end,
        height = function()
          return math.floor(vim.o.lines * 0.85)
        end,
        winblend = 0,
      },
      on_open = function(term)
        -- All keys pass through to OpenCode (Esc, Ctrl+x, etc.)
        vim.cmd("startinsert")

        -- Re-enter terminal mode automatically whenever this buffer is focused.
        local group = vim.api.nvim_create_augroup("OpenCodeFocus", { clear = true })
        vim.api.nvim_create_autocmd("BufEnter", {
          group = group,
          buffer = term.bufnr,
          callback = function() vim.cmd("startinsert") end,
        })

        -- <C-\>o closes the float from terminal mode.
        -- <C-\> is intercepted by Neovim before OpenCode sees it (same mechanism as <C-\><C-n>).
        vim.keymap.set("t", "<C-\\>o", function() opencode:toggle() end,
          { buffer = term.bufnr, silent = true, desc = "Close OpenCode" })
      end,
    })

    -- Toggle keymap (normal mode)
    vim.keymap.set("n", "<leader>oc", function()
      opencode:toggle()
    end, { desc = "OpenCode" })
  end,
}
