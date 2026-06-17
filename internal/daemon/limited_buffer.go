package daemon

import (
	"bytes"
	"os"
)

const (
	defaultProcessOutputMemoryLimit = 256 * 1024
	defaultProcessOutputReportLimit = 64 * 1024
)

type limitedCapture struct {
	memoryLimit int
	reportLimit int
	buffer      bytes.Buffer
	spill       *os.File
	spillPath   string
	truncated   bool
}

func newLimitedCapture(runID string, memoryLimit int, reportLimit int) (*limitedCapture, error) {
	if memoryLimit <= 0 {
		memoryLimit = defaultProcessOutputMemoryLimit
	}
	if reportLimit <= 0 {
		reportLimit = defaultProcessOutputReportLimit
	}
	return &limitedCapture{
		memoryLimit: memoryLimit,
		reportLimit: reportLimit,
	}, nil
}

func (c *limitedCapture) Write(p []byte) (int, error) {
	if len(p) == 0 {
		return 0, nil
	}
	written := 0
	for len(p) > 0 {
		if c.spill != nil {
			n, err := c.spill.Write(p)
			written += n
			if n < len(p) {
				c.truncated = true
			}
			if err != nil {
				return written, err
			}
			return written, nil
		}
		remaining := c.memoryLimit - c.buffer.Len()
		if remaining <= 0 {
			if err := c.openSpill(); err != nil {
				return written, err
			}
			continue
		}
		chunk := p
		if len(chunk) > remaining {
			chunk = p[:remaining]
		}
		n, err := c.buffer.Write(chunk)
		written += n
		if err != nil {
			return written, err
		}
		p = p[n:]
		if len(p) > 0 {
			if err := c.openSpill(); err != nil {
				return written, err
			}
		}
	}
	return written, nil
}

func (c *limitedCapture) openSpill() error {
	if c.spill != nil {
		return nil
	}
	file, err := os.CreateTemp("", "sikong-process-output-*")
	if err != nil {
		return err
	}
	if c.buffer.Len() > 0 {
		if _, err := file.Write(c.buffer.Bytes()); err != nil {
			_ = file.Close()
			return err
		}
		c.buffer.Reset()
	}
	c.spill = file
	c.spillPath = file.Name()
	return nil
}

func (c *limitedCapture) Result() (text string, spillPath string, truncated bool) {
	if c.spill != nil {
		_ = c.spill.Sync()
		report, err := readTailFile(c.spillPath, c.reportLimit)
		if err != nil {
			report = c.buffer.String()
		}
		return report, c.spillPath, true
	}
	text = c.buffer.String()
	if len(text) > c.reportLimit {
		text = text[len(text)-c.reportLimit:]
		return text, "", true
	}
	return text, "", c.truncated
}

func (c *limitedCapture) Close() {
	if c.spill != nil {
		_ = c.spill.Close()
	}
}

func readTailFile(path string, limit int) (string, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return "", err
	}
	if len(data) <= limit {
		return string(data), nil
	}
	return string(data[len(data)-limit:]), nil
}
