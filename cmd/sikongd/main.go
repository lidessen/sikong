package main

import (
	"context"
	"fmt"
	"os"
	"os/signal"
	"syscall"

	"sikong/internal/buildinfo"
	"sikong/internal/daemon"
)

func main() {
	if len(os.Args) > 1 {
		switch os.Args[1] {
		case "-v", "--version", "version":
			fmt.Println(buildinfo.VersionString("sikongd"))
			return
		case "-h", "--help", "help":
			printUsage()
			return
		}
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	if err := daemon.Run(ctx, os.Stdout); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func printUsage() {
	fmt.Println(`sikongd

Usage:
  sikongd [--version]

Runs the Sikong background daemon until interrupted.`)
}
