package buildinfo

var version = "dev"

func Version() string {
	return version
}

func VersionString(name string) string {
	return name + " " + version
}
