package runstore

import (
	"archive/zip"
	"io"
	"os"
	"path/filepath"
	"time"
)

type ZipWriter struct {
	zw *zip.Writer
}

func NewZipWriter(w io.Writer) *ZipWriter {
	return &ZipWriter{zw: zip.NewWriter(w)}
}

func (z *ZipWriter) Close() error { return z.zw.Close() }

func (z *ZipWriter) AddFile(absPath, zipPath string) error {
	info, err := os.Stat(absPath)
	if err != nil {
		return err
	}
	h, err := zip.FileInfoHeader(info)
	if err != nil {
		return err
	}
	h.Name = filepath.ToSlash(zipPath)
	h.Method = zip.Deflate
	h.Modified = time.Now()

	fw, err := z.zw.CreateHeader(h)
	if err != nil {
		return err
	}
	f, err := os.Open(absPath)
	if err != nil {
		return err
	}
	defer f.Close()
	_, err = io.Copy(fw, f)
	return err
}
