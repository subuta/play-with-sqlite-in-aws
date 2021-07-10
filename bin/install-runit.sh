#!/bin/bash

mkdir -p /opt/work/package
sudo chmod 1755 /opt/work/package
cd /opt/work/package
wget http://smarden.org/runit/runit-2.1.2.tar.gz
gunzip runit-2.1.2.tar.gz
tar -xpf runit-2.1.2.tar
cd ./admin/runit-2.1.2
./package/install
sudo mkdir -p /service
