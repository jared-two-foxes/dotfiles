-- Bootstrap lazy.nvim
local lazypath = vim.fn.stdpath("data") .. "/lazy/lazy.nvim"
if not vim.loop.fs_stat(lazypath) then
  vim.fn.system({
    "git",
    "clone",
    "--filter=blob:none",
    "https://github.com/folke/lazy.nvim.git",
    "--branch=stable", -- latest stable release
    lazypath,
  })
end
vim.opt.rtp:prepend(lazypath)

return require("lazy").setup({
  -- better UI
  {
    "stevearc/dressing.nvim",
    config = function()
      require("plugins/dressing").setup()
    end,
  },

  -- better UI for messages, cmdline and the popupmenu
  {
    "folke/noice.nvim",
    event = "VeryLazy",
    opts = {
      -- add any options here
    },
    dependencies = {
      "MunifTanjim/nui.nvim",
      "rcarriga/nvim-notify",
    },
    config = function()
      require("plugins/noice").setup()
    end,
  },

  -- Mason package manager for lsp servers, dap, etc.
  {
    "williamboman/mason-lspconfig.nvim",
    config = function()
      require("mason-lspconfig").setup({
        ensure_installed = {
          "lua_ls",
          "rust_analyzer",
          "cmake",
          "pylsp",
          "clangd",
        },
        automatic_installation = true,
      })
    end,
  },

  {
    "williamboman/mason.nvim",
    config = function()
      require("mason").setup()
    end,
  },

  -- Local config files
  {
    "klen/nvim-config-local",
    config = function()
      require("config-local").setup({
        -- Default configuration (optional)
        config_files = { ".vimrc.lua", ".vimrc" }, -- Config file patterns to load (lua supported)
        hashfile = vim.fn.stdpath("data") .. "/config-local", -- Where the plugin keeps files data
        autocommands_create = true, -- Create autocommands (VimEnter, DirectoryChanged)
        commands_create = true, -- Create commands (ConfigSource, ConfigEdit, ConfigTrust, ConfigIgnore)
        silent = false, -- Disable plugin messages (Config loaded/ignored)
        lookup_parents = false, -- Lookup config files in parent directories
      })
    end,
  },

  -- Keybindings configuration / visualisation
  -- Note: Keybindings are configured in keybindings.lua for better self-documentation
  {
    "folke/which-key.nvim",
  },

  -- Telescope, for fuzzy finders/browsers
  {
    "nvim-telescope/telescope.nvim",
    dependencies = { "nvim-lua/plenary.nvim", "BurntSushi/ripgrep", "nvim-telescope/telescope-media-files.nvim" },
    config = function()
      require("plugins/telescope").setup()
    end,
  },
  
  -- FZF, for fuzzy finders/browsers
  {
    "ibhagwan/fzf-lua",
    requires = { "nvim-tree/nvim-web-devicons" },
  },

  -- Code completion
  {
    "hrsh7th/nvim-cmp",
    dependencies = {
      "hrsh7th/cmp-buffer",
      "hrsh7th/cmp-nvim-lsp",
      "hrsh7th/cmp-path",
      "hrsh7th/cmp-cmdline",
      "hrsh7th/cmp-calc",
      "hrsh7th/cmp-nvim-lsp-signature-help",
      "f3fora/cmp-spell",
      "L3mon4d3/LuaSnip",
      "saadparwaiz1/cmp_luasnip",
      "rafamadriz/friendly-snippets",
      "onsails/lspkind.nvim",
      "p00f/clangd_extensions.nvim",
      "rcarriga/cmp-dap",
    },
    config = function()
      require("plugins/autocompletion").setup()
    end,
  },

  -- Configs for the built-in Language Server Protocol
  {
    "neovim/nvim-lspconfig",
    dependencies = { "williamboman/mason-lspconfig.nvim", "williamboman/mason.nvim" },
    config = function()
      require("plugins/lspconfig").setup()
    end,
  },

  -- Lsp additions
  {
    "glepnir/lspsaga.nvim",
    branch = "main",
    dependencies = { "catppuccin/nvim", "lewis6991/gitsigns.nvim" },
    config = function()
      require("plugins/lspsaga").setup()
    end,
  },

  -- clangd extensions (such as inlay hints)
  {
    "p00f/clangd_extensions.nvim",
    dependencies = "neovim/nvim-lspconfig",
    config = function()
      require("plugins/clangd").setup()
    end,
  },
  
  -- Displaying errors/warnings in a window
  {
    "folke/trouble.nvim",
    dependencies = "nvim-tree/nvim-web-devicons",
    config = function()
      require("trouble").setup({})
    end,
  },

  -- cmake
  {
    "Civitasv/cmake-tools.nvim",
    commit = "35500245db20727b730398e18c7be140e36b29dd",
    dependencies = "nvim-lua/plenary.nvim",
    config = function()
      require("plugins/cmake").setup()
    end,
  },

  -- rust
  {
    "simrat39/rust-tools.nvim",
    dependencies = "neovim/nvim-lspconfig",
    config = function()
      require("plugins/rust_tools").setup()
    end,
  },
  	
  -- comments
  {
    "numToStr/Comment.nvim",
    config = function()
      require("Comment").setup()
    end,
  },

  -- git
  {
    "TimUntersberger/neogit",
    dependencies = { "nvim-lua/plenary.nvim", "sindrets/diffview.nvim" },
    config = function()
      require("plugins/neogit").setup()
    end,
  },
 
  -- diffing/merging
  { "sindrets/diffview.nvim", dependencies = "nvim-lua/plenary.nvim" },
 
  -- debugging
  {
    "rcarriga/nvim-dap-ui",
    dependencies = {
      "mfussenegger/nvim-dap",
      "mfussenegger/nvim-dap-python",
      "theHamsta/nvim-dap-virtual-text",
      "jbyuki/one-small-step-for-vimkind",
    },
    config = function()
      require("plugins/debugging").setup()
    end,
  },

  -- Mason configuration for dap
  {
    "jayp0521/mason-nvim-dap.nvim",
    config = function()
      require("mason-nvim-dap").setup({
        automatic_installation = true,
        ensure_installed = { "python", "cppdbg", "codelldb" },
      })
    end,
  },

  -- Testing
  {
    "nvim-neotest/neotest",
    dependencies = {
      "nvim-lua/plenary.nvim",
      "nvim-treesitter/nvim-treesitter",
      "antoinemadec/FixCursorHold.nvim",
      "alfaix/neotest-gtest",
      "nvim-neotest/neotest-python",
      "rouge8/neotest-rust",
      "andy-bell101/neotest-java",
    },
    config = function()
      require("plugins/neotest").setup()
    end,
  },

  -- Tresitter for minimal syntax highlighting
  {
    "nvim-treesitter/nvim-treesitter",
    build = ":TSUpdate",
    config = function()
      require("plugins/treesitter").setup()
    end,
  },
  
  -- Statusline
  {
    "nvim-lualine/lualine.nvim",
    dependencies = { "nvim-tree/nvim-web-devicons", "mortepau/codicons.nvim" },
    config = function()
      require("plugins/lualine").setup()
    end,
  },
  
  -- Highlight & search todos
  {
    "folke/todo-comments.nvim",
    dependencies = "nvim-lua/plenary.nvim",
    config = function()
      require("plugins/todo-comments").setup()
    end,
  },

  -- Colour theme
  {
    "catppuccin/nvim",
    config = function()
      require("plugins/colourscheme").setup()
    end,
  },

  -- Indentation guides
  {
    "lukas-reineke/indent-blankline.nvim",
  },
 
  -- statuscol
  {
    "luukvbaal/statuscol.nvim",
    dependencies = { "mfussenegger/nvim-dap", "lewis6991/gitsigns.nvim" },
    config = function()
      require("plugins/statuscol").setup()
    end,
  },
 
  -- Highlight git changes in statuscol
  {
    "lewis6991/gitsigns.nvim",
    dependencies = { "petertriho/nvim-scrollbar" },
    config = function()
      require("plugins/gitsigns").setup()
    end,
  },

  -- Show current code context
  {
    "SmiteshP/nvim-navic",
    requires = "neovim/nvim-lspconfig",
    config = function()
      require("plugins/navic").setup()
    end,
  },

  -- Statusline built on navic to show the current code context
  {
    "utilyre/barbecue.nvim",
    dependencies = {
      "SmiteshP/nvim-navic",
      "nvim-tree/nvim-web-devicons", -- optional dependency
    },
    config = function()
      require("plugins/barbecue").setup()
    end,
  },
  
  -- Autopairs
  {
    "echasnovski/mini.pairs",
    version = false,
  },
  
  {
    "kevinhwang91/nvim-hlslens",
    dependencies = { "petertriho/nvim-scrollbar" },
    config = function()
      require("scrollbar.handlers.search").setup({})
    end,
  },
})
