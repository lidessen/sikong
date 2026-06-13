package main

import (
	"fmt"
	"os"

	"sikong/internal/buildinfo"
)

func main() {
	if len(os.Args) > 1 {
		switch os.Args[1] {
		case "-v", "--version", "version":
			fmt.Println(buildinfo.VersionString("sikong"))
			return
		case "-h", "--help", "help":
			printUsage()
			return
		}
	}

	fmt.Println("sikong cli initialized")
}

func printUsage() {
	fmt.Println(`sikong

Usage:
  sikong [--version]

Commands will be added as the CLI grows.`)
}
