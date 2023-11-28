return {
	{ "tpope/vim-sleuth" },
	{ "tpope/vim-repeat" },
	{ "nvim-lua/plenary.nvim" },
	{
		"tpope/vim-fugitive",
		cmd = { "Git", "GBrowse", "Gdiffsplit", "Gvdiffsplit" },
		dependencies = {
			"tpope/vim-rhubarb",
		},
	}
}
