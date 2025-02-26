#!/bin/bash

# source: https://gist.github.com/carry0987/372b9fefdd8041d0374f4e08fbf052b1

# How to: run this every minute using a cron job:
#
#  $ sudo crontab -e
#
#  * * * * * /home/pi/wifi-reconnect.sh

SSID=$(/sbin/iwgetid --raw)

if [ -z "$SSID" ]; then
    echo "`date -Is` WiFi interface is down, trying to reconnect" >> /home/pi/wifi-log.txt
    if command -v /sbin/ip &> /dev/null; then
        /sbin/ip link set wlan0 down
        sleep 10
        /sbin/ip link set wlan0 up
    elif command -v sudo ifconfig &> /dev/null; then
        sudo ifconfig wlan0 down
        sleep 10
        sudo ifconfig wlan0 up
    else
        echo "`date -Is` Failed to reconnect: neither /sbin/ip nor ifconfig commands are available" >> /home/pi/wifi-log.txt
    fi
fi

echo 'WiFi check finished'
