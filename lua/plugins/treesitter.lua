local M = {}

function M.setup()
  require("nvim-treesitter.configs").setup({
    ensure_installed = {
      "c",
      "cpp",
      "cmake",
      "bash",
      "dockerfile",
      "json",
      "llvm",
      "lua",
      "make",
      "markdown",
      "proto",
      "python",
      "regex",
      "rust",
      "vim",
    },
    sync_install = false,
    highlight = {
      enable = true,
    },
  })
end

return M

